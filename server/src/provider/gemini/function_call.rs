//! Assembles streamed Gemini function calls into complete calls for execution and replay.
use std::{collections::BTreeMap, sync::OnceLock};

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::{Error, Result};

#[derive(Default)]
pub(super) struct FunctionCalls
{
    pending: Option<PartialCall>,
}

impl FunctionCalls
{
    pub(super) fn push(&mut self, part: &Value) -> Result<Option<Value>>
    {
        let call = part["functionCall"].as_object().ok_or_else(|| stream_error("functionCall must be an object"))?;
        if self.pending.is_none() && !call.contains_key("willContinue") && !call.contains_key("partialArgs")
        {
            return Ok(Some(part.clone()));
        }

        let pending = self.pending.get_or_insert_with(|| PartialCall { part: part.clone(), arguments: BTreeMap::new() });
        pending.merge(part, call)?;
        if will_continue(call.get("willContinue"))?
        {
            return Ok(None);
        }

        self.pending.take().expect("pending function call").complete().map(Some)
    }
}

struct PartialCall
{
    part: Value,
    arguments: BTreeMap<Vec<PathSegment>, Argument>,
}

impl PartialCall
{
    fn merge(&mut self, part: &Value, call: &Map<String, Value>) -> Result<()>
    {
        let saved = self.part.as_object_mut().expect("function-call part");
        merge_field(saved, "thoughtSignature", part.get("thoughtSignature"))?;
        let saved_call = saved.get_mut("functionCall").and_then(Value::as_object_mut).expect("function-call object");
        merge_field(saved_call, "name", call.get("name"))?;
        merge_field(saved_call, "id", call.get("id"))?;
        if let Some(args) = call.get("args")
        {
            saved_call.insert("args".into(), args.clone());
        }
        if let Some(fragments) = call.get("partialArgs")
        {
            for fragment in fragments.as_array().ok_or_else(|| stream_error("partialArgs must be an array"))?
            {
                self.merge_argument(fragment)?;
            }
        }
        Ok(())
    }

    fn merge_argument(&mut self, fragment: &Value) -> Result<()>
    {
        let path = fragment.get("jsonPath").and_then(Value::as_str).ok_or_else(|| stream_error("argument fragment has no jsonPath"))?;
        let path = parse_path(path)?;
        let delta = argument_delta(fragment)?;
        let continues = will_continue(fragment.get("willContinue"))?;
        match self.arguments.get_mut(&path)
        {
            Some(argument) if argument.continues =>
            {
                if let Some(delta) = delta
                {
                    let (Value::String(text), Value::String(suffix)) = (&mut argument.value, delta) else
                    {
                        return Err(stream_error("only strings can have multiple argument fragments"));
                    };
                    text.push_str(&suffix);
                }
                argument.continues = continues;
            }
            Some(_) => return Err(stream_error("received another fragment for a completed argument")),
            None =>
            {
                let value = delta.ok_or_else(|| stream_error("first fragment has no argument value"))?;
                self.arguments.insert(path, Argument { value, continues });
            }
        }
        Ok(())
    }

    fn complete(mut self) -> Result<Value>
    {
        let call = self.part["functionCall"].as_object_mut().expect("function-call object");
        call.remove("partialArgs");
        call.remove("willContinue");
        if !call.contains_key("args") && !self.arguments.is_empty()
        {
            let mut args = json!({});
            let mut previous_path: Option<Vec<PathSegment>> = None;
            // Sorted paths let arrays be built without allocating sparse or unbounded indices.
            for (path, argument) in self.arguments
            {
                if argument.continues || previous_path.as_ref().is_some_and(|previous| path.starts_with(previous))
                {
                    return Err(stream_error("incomplete or conflicting argument fragments"));
                }
                insert_argument(&mut args, &path, argument.value)?;
                previous_path = Some(path);
            }
            call.insert("args".into(), args);
        }
        Ok(self.part)
    }
}

fn merge_field(target: &mut Map<String, Value>, name: &str, value: Option<&Value>) -> Result<()>
{
    if let Some(value) = value
    {
        if target.insert(name.into(), value.clone()).is_some_and(|previous| previous != *value)
        {
            return Err(stream_error("function-call metadata changed across fragments"));
        }
    }
    Ok(())
}

struct Argument
{
    value: Value,
    continues: bool,
}

fn argument_delta(fragment: &Value) -> Result<Option<Value>>
{
    let mut deltas = ["stringValue", "numberValue", "boolValue", "nullValue"].into_iter().filter_map(|key| fragment.get(key).map(|value| (key, value)));
    let Some((key, value)) = deltas.next() else { return Ok(None) };
    let valid = matches!((key, value), ("stringValue", Value::String(_)) | ("numberValue", Value::Number(_)) | ("boolValue", Value::Bool(_)) | ("nullValue", Value::Null));
    if !valid || deltas.next().is_some()
    {
        return Err(stream_error("argument fragment has an invalid delta"));
    }
    Ok(Some(value.clone()))
}

fn will_continue(flag: Option<&Value>) -> Result<bool>
{
    flag.map_or(Ok(false), |value| value.as_bool().ok_or_else(|| stream_error("willContinue must be a boolean")))
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum PathSegment
{
    Field(String),
    Index(usize),
}

fn parse_path(path: &str) -> Result<Vec<PathSegment>>
{
    static SELECTOR: OnceLock<Regex> = OnceLock::new();
    let selector = SELECTOR.get_or_init(|| Regex::new(r#"^\s*(?:\.([a-zA-Z_\u{80}-\u{10FFFF}][a-zA-Z0-9_\u{80}-\u{10FFFF}]*)|\[\s*(?:(0|[1-9][0-9]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))\s*\])"#).expect("JSONPath selector regex"));
    let invalid = || stream_error("argument jsonPath must name a field or nonnegative array index");
    let mut remaining = path.strip_prefix('$').ok_or_else(invalid)?;
    let mut path = Vec::new();
    while !remaining.trim().is_empty()
    {
        let groups = selector.captures(remaining).ok_or_else(invalid)?;
        let segment = if let Some(field) = groups.get(1)
        {
            PathSegment::Field(field.as_str().into())
        }
        else if let Some(index) = groups.get(2)
        {
            PathSegment::Index(index.as_str().parse().map_err(|_| invalid())?)
        }
        else
        {
            let field = groups.get(3).expect("quoted field selector").as_str();
            let field = if field.starts_with('"')
            {
                serde_json::from_str(field).map_err(|_| invalid())?
            }
            else
            {
                json5::from_str(field).map_err(|_| invalid())?
            };
            PathSegment::Field(field)
        };
        path.push(segment);
        if path.len() > 128
        {
            return Err(stream_error("argument jsonPath exceeds the JSON nesting limit"));
        }
        remaining = &remaining[groups.get(0).expect("matched selector").end()..];
    }
    if path.is_empty()
    {
        return Err(invalid());
    }
    Ok(path)
}

fn insert_argument(mut args: &mut Value, path: &[PathSegment], value: Value) -> Result<()>
{
    let conflict = || stream_error("argument jsonPath conflicts with another argument");
    for segment in path
    {
        match segment
        {
            PathSegment::Field(field) =>
            {
                if args.is_null()
                {
                    *args = json!({});
                }
                args = args.as_object_mut().ok_or_else(conflict)?.entry(field.clone()).or_insert(Value::Null);
            }
            PathSegment::Index(index) =>
            {
                if args.is_null()
                {
                    *args = json!([]);
                }
                let array = args.as_array_mut().ok_or_else(conflict)?;
                if *index == array.len()
                {
                    array.push(Value::Null);
                }
                args = array.get_mut(*index).ok_or_else(|| stream_error("argument jsonPath skips an array index"))?;
            }
        }
    }
    *args = value;
    Ok(())
}

fn stream_error(reason: &str) -> Error
{
    Error::Provider(format!("Gemini streamed function call: {reason}"))
}
