import { useEffect, useMemo, useRef, useState } from "react";
import type { BugMediaGroup, BugMediaItem, Period } from "../shared/types";
import "./bug-media.css";

interface Props {
  period: Period;
  groups: BugMediaGroup[];
  loading: boolean;
  error: string;
  selectedBugId: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const requestFor = (period: Period, item: BugMediaItem) => ({
  period,
  bugId: item.bugId,
  mediaId: item.id,
});

function useImageUrl(period: Period, item: BugMediaItem, original = false) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setUrl("");
    setError("");
    void window.tapd.getBugMediaUrl({
      ...requestFor(period, item),
      variant: original ? "original" : "thumbnail",
    }).then((value) => {
      if (active) setUrl(value);
    }).catch((reason) => {
      if (active) setError(messageOf(reason));
    });
    return () => { active = false; };
  }, [period.start, period.end, item.bugId, item.id, original]);
  return { url, error };
}

function MediaCard({ period, item, onEnlarge }: {
  period: Period;
  item: BugMediaItem;
  onEnlarge: () => void;
}) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [videoUrl, videoFailed]);
  async function action(fn: () => Promise<void>, success: string) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await fn();
      setNotice(success);
    } catch (reason) {
      setError(messageOf(reason));
    } finally { setBusy(false); }
  }
  return (
    <article className={`bug-media-card bug-media-${item.kind}`} data-media-id={item.id}>
      {item.kind === "image" ? (
        <ImageThumbnail period={period} item={item} onEnlarge={onEnlarge} />
      ) : (
        <div className="bug-media-video-wrap">
          {videoUrl && !videoFailed ? (
            <video ref={videoRef} controls autoPlay preload="none" src={videoUrl}
              aria-label={`视频 ${item.fileName}`}
              onError={() => setVideoFailed(true)} />
          ) : videoFailed ? (
            <p className="bug-media-error" role="alert">
              视频无法在当前播放器中加载，请点击“定位文件”使用本地播放器打开。
            </p>
          ) : (
            <button type="button" disabled={busy} className="bug-media-play"
              onClick={() => void action(async () => {
                const url = await window.tapd.getBugMediaUrl({
                  ...requestFor(period, item), variant: "original",
                });
                setVideoFailed(false);
                setVideoUrl(url);
              }, "")}>▶ 加载并播放视频</button>
          )}
        </div>
      )}
      <div className="bug-media-card-caption">
        <strong title={item.fileName}>{item.fileName}</strong>
        <span>{item.source}{item.width > 0 && item.height > 0 ? ` · ${item.width}×${item.height}` : ""}</span>
      </div>
      <div className="bug-media-actions">
        {item.kind === "image" && <>
          <button type="button" disabled={busy} aria-label={`复制图片 ${item.fileName}`} onClick={() => void action(
            () => window.tapd.copyBugMediaImage(requestFor(period, item)), "图片已复制",
          )}>复制图片</button>
          <button type="button" onClick={onEnlarge}>放大</button>
        </>}
        <button type="button" disabled={busy} onClick={() => void action(
          () => window.tapd.revealBugMedia(requestFor(period, item)), "",
        )}>定位文件</button>
      </div>
      {notice && <p className="bug-media-feedback" role="status">{notice}</p>}
      {error && <p className="bug-media-error" role="alert">操作失败：{error}{item.kind === "video" ? "；可尝试定位文件后使用本地播放器打开。" : ""}</p>}
    </article>
  );
}

function ImageThumbnail({ period, item, onEnlarge }: {
  period: Period; item: BugMediaItem; onEnlarge: () => void;
}) {
  const { url, error } = useImageUrl(period, item);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <button type="button" className="bug-media-thumbnail" onClick={onEnlarge}
      aria-label={`放大图片 ${item.fileName}`}>
      {error || failed ? <span className="bug-media-error">图片预览加载失败，可放大重试或定位文件。</span>
        : url ? <img src={url} alt={item.fileName} loading="lazy" onError={() => setFailed(true)} />
        : <span>正在加载预览…</span>}
    </button>
  );
}

function ImageLightbox({ period, images, index, onIndex, onClose }: {
  period: Period; images: BugMediaItem[]; index: number;
  onIndex: (index: number) => void; onClose: () => void;
}) {
  const item = images[index];
  const { url, error } = useImageUrl(period, item, true);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => setFailed(false), [url]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = oldOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="bug-media-lightbox" onClick={onClose}>
      <div ref={dialogRef} className="bug-media-lightbox-dialog" role="dialog"
        aria-modal="true" aria-label={`图片大图 ${item.fileName}`} tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key === "ArrowLeft") { event.preventDefault(); onIndex((index + images.length - 1) % images.length); }
          if (event.key === "ArrowRight") { event.preventDefault(); onIndex((index + 1) % images.length); }
          if (event.key === "Tab") {
            const elements = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
            if (!elements?.length) return;
            const first = elements[0], last = elements[elements.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
              event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
              event.preventDefault(); first.focus();
            }
          }
        }}>
        <div className="bug-media-lightbox-toolbar">
          <span>{index + 1} / {images.length} · {item.fileName}</span>
          <button type="button" onClick={onClose} aria-label="关闭大图">关闭 ×</button>
        </div>
        <div className="bug-media-lightbox-stage">
          {error || failed ? <p role="alert">原图加载失败，请关闭后重试，或使用“定位文件”。{error}</p>
            : url ? <img src={url} alt={item.fileName} onError={() => setFailed(true)} />
            : <p role="status">正在加载原图…</p>}
        </div>
        <div className="bug-media-lightbox-navigation">
          <button type="button" disabled={images.length < 2} onClick={() => onIndex((index + images.length - 1) % images.length)}>← 上一张</button>
          <span>Esc 关闭 · ← → 切换</span>
          <button type="button" disabled={images.length < 2} onClick={() => onIndex((index + 1) % images.length)}>下一张 →</button>
        </div>
      </div>
    </div>
  );
}

export function BugMediaBrowser({ period, groups, loading, error, selectedBugId, onSelect, onRefresh }: Props) {
  const [query, setQuery] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [folderError, setFolderError] = useState("");
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return groups.filter((group) => `${group.bugId} ${group.title}`.toLocaleLowerCase().includes(value));
  }, [groups, query]);
  const selected = filtered.find((group) => group.bugId === selectedBugId) ?? filtered[0];
  const images = selected?.items.filter((item) => item.kind === "image") ?? [];
  useEffect(() => { setLightboxIndex(null); setFolderError(""); }, [selected?.bugId, period.start, period.end]);
  useEffect(() => {
    if (selected && selected.bugId !== selectedBugId) onSelect(selected.bugId);
  }, [selected?.bugId, selectedBugId, onSelect]);
  return (
    <div className="bug-media-browser" aria-label="Bug 媒体浏览器">
      <div className="bug-media-topbar">
        <p>按 Bug 单查看已提取的图片和视频</p>
        <button type="button" disabled={loading} onClick={onRefresh}>{loading ? "正在读取…" : "刷新媒体"}</button>
      </div>
      {loading && <p className="bug-media-state" role="status">正在读取本地媒体…</p>}
      {error && <div className="bug-media-index-error" role="alert">
        <span>媒体索引读取失败：{error}{groups.length > 0 ? "；以下仍显示已读取内容，可能不完整。" : ""}</span>
        <button type="button" disabled={loading} onClick={onRefresh}>重试</button>
      </div>}
      {!loading && !error && groups.length === 0 && <p className="bug-media-state">当前日期范围暂无已提取的 Bug 媒体。先点击“提取 Bug 图片和视频”，完成后在这里查看。</p>}
      {groups.length > 0 && <div className="bug-media-layout">
        <aside className="bug-media-sidebar" aria-label="Bug 单列表">
          <input type="search" aria-label="搜索 Bug 单号或标题" placeholder="搜索单号或标题" value={query} onChange={(event) => setQuery(event.target.value)} />
          <p className="bug-media-count">{filtered.length} / {groups.length} 个 Bug 单</p>
          <div className="bug-media-list">
            {filtered.map((group) => <button type="button" key={group.bugId}
              className="bug-media-ticket" aria-label={`查看 Bug #${group.bugId} 媒体`} aria-current={selected?.bugId === group.bugId ? "true" : undefined}
              onClick={() => { setLightboxIndex(null); onSelect(group.bugId); }}>
              <strong>#{group.bugId}</strong>
              <span className="bug-media-ticket-title">{group.title || "未记录标题"}</span>
              <span className="bug-media-ticket-count">{group.items.filter((item) => item.kind === "image").length} 图片 · {group.items.filter((item) => item.kind === "video").length} 视频</span>
            </button>)}
          </div>
          {filtered.length === 0 && <p className="bug-media-state">没有找到匹配的 Bug。</p>}
        </aside>
        <div className="bug-media-detail" key={`${period.start}:${period.end}:${selected?.bugId ?? "none"}`}>
          {selected ? <>
            <div className="bug-media-detail-heading">
              <div><h3>#{selected.bugId}</h3><p>{selected.title || "未记录标题"}</p></div>
              {selected.outputPath && <button type="button" onClick={() => {
                setFolderError("");
                void window.tapd.openPath(selected.outputPath).catch((reason) => setFolderError(messageOf(reason)));
              }}>打开文件夹</button>}
            </div>
            {folderError && <p className="bug-media-error" role="alert">打开文件夹失败：{folderError}</p>}
            {selected.items.length === 0 && <p className="bug-media-state">该 Bug 暂无可预览媒体。</p>}
            <div className="bug-media-grid">
              {selected.items.map((item) => <MediaCard key={item.id} period={period} item={item}
                onEnlarge={() => setLightboxIndex(images.findIndex((image) => image.id === item.id))} />)}
            </div>
          </> : <p className="bug-media-state">调整搜索内容以查看 Bug 媒体。</p>}
        </div>
      </div>}
      {lightboxIndex !== null && lightboxIndex >= 0 && images[lightboxIndex] && <ImageLightbox
        key={`${period.start}:${period.end}:${selected?.bugId}`}
        period={period} images={images} index={lightboxIndex}
        onIndex={setLightboxIndex} onClose={() => setLightboxIndex(null)} />}
    </div>
  );
}
