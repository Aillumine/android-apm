(function () {
  "use strict";

  async function renderCpuOverview(container, dateStart, dateEnd) {
    if (![dateStart, dateEnd].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date || ""))) return;
    const range = `${dateStart}_${dateEnd}`;
    const response = await fetch(`prefetch/anr/${range}-overview.json`, {
      credentials: "include", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return;
    const overview = await response.json();
    if (overview.schema !== 1 || overview.dateStart !== dateStart || overview.dateEnd !== dateEnd) return;
    const section = document.createElement("section");
    section.id = "cpuOverview";
    const title = document.createElement("h2");
    title.textContent = "高 CPU 来源概览";
    const detail = document.createElement("p");
    detail.textContent = `${dateStart} 至 ${dateEnd} · CPU > ${overview.threshold}% · ${overview.sampleCount.toLocaleString()} 条采样 · ${overview.eventsAboveThreshold.toLocaleString()} 起 ANR`;
    const list = document.createElement("ul");
    for (const [key, count] of overview.categories) {
      const item = document.createElement("li");
      const category = window.AnrCategories.CATEGORY[key];
      if (!category) throw new Error("Unknown CPU category");
      const percentage = count * 100 / overview.sampleCount;
      item.textContent = `${category.name} · ${count.toLocaleString()} 条（${percentage.toFixed(1)}%）`;
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = percentage;
      bar.setAttribute("aria-label", category.name + "占比");
      bar.style.accentColor = category.color;
      item.append(" ", bar);
      list.append(item);
    }
    section.append(title, detail, list);
    container.append(section);
    return section;
  }

  window.renderAnrCpuOverview = renderCpuOverview;
})();
