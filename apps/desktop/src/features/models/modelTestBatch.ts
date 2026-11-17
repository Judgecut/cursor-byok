export interface ModelTestTarget
{
  model_hash: string;
  display_name: string;
}

export type ModelTestOutcome = "success" | "failure" | "cancelled";

/** One request at a time; cancellation also stops models that have not started. */
export async function runModelTestBatch(models: readonly ModelTestTarget[], testModel: (model: ModelTestTarget) => Promise<ModelTestOutcome>, signal: AbortSignal): Promise<ModelTestOutcome[]>
{
  const results: ModelTestOutcome[] = [];
  for (const model of models)
  {
    if (signal.aborted)
    {
      break;
    }
    results.push(await testModel(model));
  }
  return results;
}
