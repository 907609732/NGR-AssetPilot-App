import { useId, useState } from "react";
import { normalizeLevel, validLevel } from "../shared/report";

const presets = ["S1", "S2", "S3"];

export function LevelEditor({
  value,
  shortId,
  disabled,
  onSave,
}: {
  value: string;
  shortId: string;
  disabled: boolean;
  onSave: (level: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();
  async function save() {
    if (disabled) return;
    const level = normalizeLevel(input);
    if (!validLevel(level)) {
      setError("请输入 S 加非负整数，如 S4 或 4");
      return;
    }
    if (await onSave(level)) setEditing(false);
  }
  return (
    <div className="level-editor">
      {editing ? (
        <>
          <input
            autoFocus
            aria-label={`自定义 S 等级 ${shortId}`}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            placeholder="如 S4 或 4"
            value={input}
            disabled={disabled}
            onChange={(e) => {
              setInput(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape" && !disabled) setEditing(false);
            }}
          />
          <div className="level-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void save()}
            >
              保存等级
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
          {error && (
            <span className="level-error" id={errorId} role="alert">
              {error}
            </span>
          )}
        </>
      ) : (
        <div className="level-actions">
          <select
            aria-label={`S 等级 ${shortId}`}
            className={!validLevel(value) ? "needs-confirmation" : ""}
            value={value}
            disabled={disabled}
            onChange={(e) => void onSave(e.target.value)}
          >
            <option value="">待确认</option>
            {presets.map((level) => (
              <option key={level}>{level}</option>
            ))}
            {value && !presets.includes(value) && (
              <option value={value}>{value}</option>
            )}
          </select>
          <button
            type="button"
            aria-label={`自定义等级 ${shortId}`}
            disabled={disabled}
            onClick={() => {
              setInput(value);
              setError("");
              setEditing(true);
            }}
          >
            自定义
          </button>
        </div>
      )}
    </div>
  );
}
