// Just enough Markdown for agent replies: code blocks, inline code, bold, links, headings and lists.
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const inline = text => esc(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function markdown(source) {
  const out = [];
  const parts = String(source || '').split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
    let list = null;
    const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map(t => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`); list = null; } };
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    for (const line of part.split('\n')) {
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
    flushPara();
    flush();
  });
  return out.join('');
}
