import type { FileRef } from "@chatter/shared";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Attachments under a message: images inline, everything else as a download card. */
export function MessageFiles({ files }: { files: FileRef[] }) {
  if (files.length === 0) return null;
  return (
    <div className="message-files">
      {files.map((f) =>
        f.inline ? (
          <a key={f.id} href={f.url} target="_blank" rel="noreferrer" className="file-image" title={f.name}>
            <img src={f.url} alt={f.name} loading="lazy" />
          </a>
        ) : (
          <a key={f.id} href={f.url} download={f.name} className="file-card">
            <span className="file-icon">📄</span>
            <span className="file-meta">
              <strong>{f.name}</strong>
              <small className="muted">{formatBytes(f.size)}</small>
            </span>
          </a>
        ),
      )}
    </div>
  );
}
