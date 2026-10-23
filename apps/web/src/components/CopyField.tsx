import { useState } from "react";

/** A read-only value with a copy button, for links shown once. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <button
        className="secondary"
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}
