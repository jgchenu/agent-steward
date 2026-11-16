type Element = Record<string, unknown>;
const plain = (content: string) => ({tag:'plain_text',content});
const md = (content: string): Element => ({tag:'markdown',content});
const box = (elements: Element[], background = 'grey-50'): Element => ({tag:'column_set',flex_mode:'none',columns:[{tag:'column',width:'weighted',weight:1,padding:'12px',vertical_spacing:'8px',background_style:background,elements}]});

/** Presentation only: never infer a verdict, grant actions, or discard the original prose. */
export function summaryCard(text: string, kind: 'reply'|'report'|'overview'|'alert' = 'reply'): Record<string, unknown> {
  const safe=text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/!\[([^\]]*)\]\(([^)]+)\)/g,'[图片：$1]($2)');
  const paragraphs=safe.split(/\n\n+/).filter(Boolean);
  const title=kind==='overview'?'PR 跟进总览':kind==='alert'?'问题处理进展':kind==='report'?'监控汇总':'分身回复';
  const elements:Element[]=[];
  if(kind==='reply')elements.push(box([md(safe)],'blue-50'));
  else {
    // Recognize only controller-owned report formats; other numeric prose stays intact.
    const metrics=kind==='report' && safe.match(/本期跟进 (\d+) 个问题；PR：已合并 (\d+)，待合并 (\d+)，已关闭未合并 (\d+)/);
    const daily=kind==='report' && safe.match(/([\d,]+) 次报错[^｜\n]*｜\s*(\d+) 个问题\s*｜\s*新增 (\d+) 个/);
    const overview=kind==='overview' ? [...safe.matchAll(/(?:^|\n)(需要你处理|等待验证或审查|已合并|已关闭)（(\d+)）/g)] : [];
    const values=metrics?[['跟进问题',metrics[1]],['已合并 PR',metrics[2]],['待合并 PR',metrics[3]]]:daily?[['报错次数',daily[1]],['问题数',daily[2]],['新增问题',daily[3]]]:overview.map(m=>[m[1],m[2]]);
    if(values.length)elements.push({tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:values.map(([label,value])=>({tag:'column',width:'weighted',weight:1,padding:'12px',background_style:'blue-50',vertical_spacing:'4px',elements:[{tag:'markdown',content:`**${value}**`,text_size:'heading-2',text_align:'center'},{tag:'markdown',content:label,text_size:'notation',text_align:'center'}]}))});
    // Keep related paragraphs together; long reports retain all detail in one local fold.
    const groups: string[][]=[];
    for(const p of paragraphs){if(/^\*\*[^\n]+\*\*(?:\n|$)/.test(p)||groups.length===0)groups.push([p]);else groups.at(-1)!.push(p);}
    if(groups.length===1 && paragraphs.length>2){groups.splice(0,1,[paragraphs[0]],[paragraphs[1]],paragraphs.slice(2));}
    if(daily && groups.length>2){
      // Header/context and metric line remain in the first block; show the conclusion
      // and priority findings before folding less urgent categories.
      groups.splice(0,2,[...groups[0],...groups[1]]);
    }
    const visible=values.length?2:3;
    for(const g of groups.slice(0,visible))elements.push(box([md(g.join('\n\n'))]));
    if(groups.length>visible)elements.push({tag:'collapsible_panel',expanded:false,header:{title:plain('更多分类与统计口径')},elements:[md(groups.slice(visible).map(g=>g.join('\n\n')).join('\n\n'))]});
  }
  elements.push({tag:'markdown',content:'可直接回复这条消息继续讨论',text_size:'notation'});
  return {schema:'2.0',config:{update_multi:true,enable_forward:true,width_mode:'default',summary:{content:title}},header:{title:plain(kind==='report'?(paragraphs[0]?.split('\n')[0].replace(/\*\*/g,'').slice(0,100)||title):title),subtitle:plain(kind==='reply'?'Agent 分身':'进展与结论 · 详情可展开'),template:'blue',icon:{tag:'standard_icon',token:'todo_colorful'}},body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements}};
}
