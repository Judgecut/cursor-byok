import { useState } from "react";
import { useI18n } from "../../i18n/store";
import { Icon } from "./Icon";
import { chevronLeftIcon, chevronRightIcon } from "./icons";
import controls from "./Controls.module.scss";
import styles from "./MonthCalendar.module.scss";

/** Local calendar day as `YYYY-MM-DD`. */
export type CalendarDay = string;

export function toCalendarDay(date: Date): CalendarDay {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function fromCalendarDay(day: CalendarDay) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** Month grid that highlights one selected day and an optional day range. */
export function MonthCalendar({ selected, rangeStart, rangeEnd, onSelect }: {
  selected: CalendarDay;
  rangeStart?: CalendarDay;
  rangeEnd?: CalendarDay;
  onSelect: (day: CalendarDay) => void;
}) {
  const { locale } = useI18n();
  const [viewedMonth, setViewedMonth] = useState(() => monthKey(fromCalendarDay(selected)));
  const [followedDay, setFollowedDay] = useState(selected);
  // Follow the selected day into view when it changes from outside the grid.
  if (followedDay !== selected) {
    setFollowedDay(selected);
    setViewedMonth(monthKey(fromCalendarDay(selected)));
  }

  const [year, month] = viewedMonth.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const days = Array.from({ length: 42 }, (_, index) => new Date(year, month - 1, 1 - first.getDay() + index));
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  const today = toCalendarDay(new Date());
  const shiftMonth = (delta: number) => setViewedMonth(monthKey(new Date(year, month - 1 + delta, 1)));

  return <div className={styles.root}>
    <div className={styles.header}>
      <button type="button" className={controls.iconButton} aria-label={t("上个月")} onClick={() => shiftMonth(-1)}>
        <Icon icon={chevronLeftIcon} />
      </button>
      <span aria-live="polite">{new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(first)}</span>
      <button type="button" className={controls.iconButton} aria-label={t("下个月")} onClick={() => shiftMonth(1)}>
        <Icon icon={chevronRightIcon} />
      </button>
    </div>
    <div className={styles.grid} role="grid">
      {days.slice(0, 7).map((date) => <span key={date.getDay()} className={styles.weekday} role="columnheader">{weekdayFormat.format(date)}</span>)}
      {days.map((date) => {
        const day = toCalendarDay(date);
        const inRange = rangeStart !== undefined && rangeEnd !== undefined && day >= rangeStart && day <= rangeEnd;
        return <button
          key={day}
          type="button"
          role="gridcell"
          className={styles.day}
          data-outside={date.getMonth() !== month - 1 || undefined}
          data-today={day === today || undefined}
          data-in-range={inRange || undefined}
          aria-selected={day === selected}
          onClick={() => onSelect(day)}
        >{date.getDate()}</button>;
      })}
    </div>
  </div>;
}

function monthKey(date: Date) {
  return toCalendarDay(date).slice(0, 7);
}
