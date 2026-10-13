import type { RawItem } from "../shared/types";

// This function runs inside the TAPD page. It reads rendered DOM only.
export function readTapdDOM() {
  const text = (e: Element | null | undefined) => e?.textContent?.trim() ?? "";
  const projects = new Map<string, string>();
  document.querySelectorAll("a[href]").forEach((a) => {
    const match = a
      .getAttribute("href")
      ?.match(/\/tapd_fe\/(\d+)\/(?:story|bug|task)\//);
    if (match && text(a) && !/^\d+$/.test(text(a)))
      projects.set(match[1], text(a));
  });
  const invalid: string[] = [];
  const items: (RawItem & { group: string })[] = [];
  const heads = [...document.querySelectorAll(".item-head")];
  const groups = heads.map((head, index) => {
    const parent = head.parentElement!;
    const name = text(head.querySelector(".item-name")) || `分组${index + 1}`;
    const expected = Number(
      text(head.querySelector(".item-total")).replace(/[^0-9]/g, ""),
    );
    const container = parent.querySelector(
      ".item-container",
    ) as HTMLElement | null;
    const collapsed =
      !!container && getComputedStyle(container).display === "none";
    const rows = parent.querySelectorAll("tr[workspace_id][type]");
    rows.forEach((row) => {
      const id = row.getAttribute("id") ?? "";
      const workspaceId = row.getAttribute("workspace_id") ?? "";
      const type = row.getAttribute("type") ?? "";
      const titleEl = row.querySelector(
        ".title-input__link--clickable, .title-input__link",
      );
      const title = text(titleEl);
      const timeEl = row.querySelector('[data-grid-field="done_time"]');
      const processedAt =
        timeEl?.getAttribute("data-grid-value") || text(timeEl);
      if (
        !id ||
        !workspaceId ||
        !type ||
        !title ||
        !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(processedAt)
      ) {
        invalid.push(`分组${name}中有记录缺少ID、标题或处理时间`);
        return;
      }
      const linkEl = row.querySelector('[data-grid-field="id"] [href]');
      items.push({
        key: `${workspaceId}:${type}:${id}`,
        id,
        workspaceId,
        type,
        title,
        workspaceName: projects.get(workspaceId) ?? workspaceId,
        shortId: text(linkEl) || id,
        typeLabel: text(row.querySelector(".workitem-icon")) || type,
        status: text(row.querySelector('[data-grid-field="status"]')),
        owner:
          row
            .querySelector('[data-grid-field="owner"]')
            ?.getAttribute("data-grid-value") ?? "",
        processedAt: processedAt.replace("T", " ").slice(0, 19),
        url:
          linkEl?.getAttribute("href") || titleEl?.getAttribute("href") || "",
        group: name,
      });
    });
    return { name, expected, collapsed, index };
  });
  const totalText = text(
    document.querySelector(".operation-right__filter-info"),
  );
  const totalMatch = totalText.match(/共\s*([\d,]+)\s*个/);
  const active = text(
    document.querySelector(
      ".worktable-tab-left:not(.new-tab-left) .list-item--active",
    ),
  );
  const account =
    document.querySelector(".avatar-nav")?.getAttribute("title") ?? "";
  const scopes = ["space", "category"].map((s) =>
    text(document.querySelector(`.item-value__${s} > .tapd-select-tag`)),
  );
  const filters = [
    ...document.querySelectorAll(
      ".tapd-filter-item__value:not(.tapd-filter-item__value--empty)",
    ),
  ].map((e) => text(e));
  const keyword =
    (
      document.querySelector(
        ".tapd-filter-item--keyword input",
      ) as HTMLInputElement | null
    )?.value ?? "";
  return {
    account,
    active,
    scopes,
    filters,
    keyword,
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null,
    groups,
    items,
    invalid,
  };
}
export type DOMCapture = ReturnType<typeof readTapdDOM>;
