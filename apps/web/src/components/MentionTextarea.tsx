import { useRef, useState, type KeyboardEvent } from "react";
import { matchMembers, useDirectory, type MentionMap } from "../directory";

interface Suggestion {
  id: string | null; // null = @channel
  label: string;
}

/** The `@query` the caret sits in, if any. */
function activeQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/**
 * A textarea with `@` autocomplete. Picked names are recorded in `picked`
 * so the caller can turn them into mention tokens on submit.
 */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  picked,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  picked: MentionMap;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { users } = useDirectory();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const q = activeQuery(value, caret);
  const suggestions: Suggestion[] =
    q && dismissed !== q.start
      ? [
          ...("channel".startsWith(q.query.toLowerCase()) ? [{ id: null, label: "channel" }] : []),
          ...matchMembers(users, q.query).map((u) => ({ id: u.id, label: u.displayName })),
        ]
      : [];
  const open = suggestions.length > 0;

  const choose = (s: Suggestion) => {
    if (!q) return;
    const display = `@${s.label}`;
    if (s.id) picked.set(display, s.id);
    const next = `${value.slice(0, q.start)}${display} ${value.slice(caret)}`;
    onChange(next);
    const pos = q.start + display.length + 1;
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(suggestions[Math.min(highlight, suggestions.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(q!.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="mention-input">
      {open && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.id ?? "channel"}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : undefined}
              onMouseDown={(e) => (e.preventDefault(), choose(s))}
            >
              <strong>@{s.label}</strong>
              {s.id === null && <span className="muted"> 대화 참여자 모두에게 알림</span>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
        autoFocus={autoFocus}
      />
    </div>
  );
}
