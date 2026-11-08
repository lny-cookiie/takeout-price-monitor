export function csvRows(text:string) {
  const rows:string[][]=[];
  let row:string[]=[],value='',quoted=false,closed=false;
  for(let i=0;i<=text.length;i++) {
    const c=text[i];
    if(quoted) {
      if(c===undefined) throw new Error('CSV 引号未闭合。');
      if(c==='"') {
        if(text[i+1]==='"'){value+='"';i++;}
        else {quoted=false;closed=true;}
      } else value+=c;
      continue;
    }
    if(c==='"' && value==='' && !closed){quoted=true;continue;}
    if(c===undefined || c===',' || c==='\r' || c==='\n') {
      row.push(value.trim());value='';closed=false;
      if(c!==',') {
        if(row.some(Boolean))rows.push(row);
        row=[];
        if(c==='\r' && text[i+1]==='\n')i++;
      }
      continue;
    }
    if(closed || c==='"')throw new Error('CSV 引号格式有误。');
    value+=c;
  }
  return rows;
}
