// Just enough Markdown for agent replies: code blocks, inline code, bold, italics, links, headings, lists and tables.
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const inline = text => esc(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:!?)]|$)/g, '$1<i>$2</i>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function markdown(source) {
  const out = [];
  const parts = String(source || '').split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
    let list = null;
    const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map(t => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`); list = null; } };
    let para = [];
    // A table is a run of lines starting with "|"; the second line is the |---| divider.
    let table = [];
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const flushTable = () => {
      if (!table.length) return;
      if (table.length > 1 && /^[\s|:-]+$/.test(table[1])) {
        const [headRow, , ...rows] = table;
        out.push(`<div class="table"><table><thead><tr>${cells(headRow).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else para.push(...table);
      table = [];
    };
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    for (const line of part.split('\n')) {
      if (/^\s*\|/.test(line)) { flushPara(); flush(); table.push(line); continue; }
      flushTable();
      const bullet = line.match(/^\s*[-*•]\s+(.*)/);
      const num = line.match(/^\s*\d+[.)]\s+(.*)/);
      const head = line.match(/^#{1,6}\s+(.*)/);
      if (bullet || num) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list?.tag !== tag) { flush(); list = { tag, items:[] }; }
        list.items.push((bullet || num)[1]);
      } else if (head) { flushPara(); flush(); out.push(`<p><b>${inline(head[1])}</b></p>`); }
      else if (!line.trim()) { flushPara(); flush(); }
      else { flush(); para.push(line); }
    }
    flushTable();
    flushPara();
    flush();
  });
  return out.join('');
}
