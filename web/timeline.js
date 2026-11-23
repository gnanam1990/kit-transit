"use strict";

// Rows and heights come from the realm's immutable sequence. The cursor
// advances across other kits as well, so sparse histories can be paged.
async function showKitTimeline(container, kit, selectedLeg = "") {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = "Confirmed custody history";
  const rows = document.createElement("ol");
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Load more history";
  next.hidden = true;
  section.append(heading, rows, message, next);
  container.appendChild(section);
  let cursor = 0;
  async function readPage() {
    next.disabled = true;
    try {
      const params = new URLSearchParams({kit, after: String(cursor)});
      const response = await fetch("/api/reader/timeline?" + params);
      if (!response.ok) throw new Error();
      const data = await response.json();
      for (const ev of data.events) {
        if (selectedLeg && ev.leg && ev.leg !== selectedLeg) continue;
        const row = document.createElement("li");
        row.dataset.sequence = ev.seq;
        row.textContent = [ev.org, ev.kind, ev.leg, ev.line, ev.data, "height " + ev.height]
          .filter(Boolean).join(" · ");
        rows.appendChild(row);
      }
      cursor = data.cursor;
      next.hidden = !data.more;
      message.textContent = !rows.children.length && !data.more ? "No confirmed events for this selection." : "";
    } catch {
      message.textContent = "Could not read the chain. Retry to load the remaining history.";
      next.hidden = false;
    } finally { next.disabled = false; }
  }
  next.onclick = readPage;
  await readPage();
}
