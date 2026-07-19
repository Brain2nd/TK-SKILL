// === FastMoss ES Email Harvester — retry missing only ===
// Run this after a few minutes to avoid MSG_SAFE_0001
(function() {
var SALT = 'LAA6edGHBkcc3eTiOIRfg89bu9ODA6PB';
var md5 = function(s) {
  function md5cycle(x,k){var a=x[0],b=x[1],c=x[2],d=x[3];a=ff(a,b,c,d,k[0],7,-680876936);d=ff(d,a,b,c,k[1],12,-389564586);c=ff(c,d,a,b,k[2],17,606105819);b=ff(b,c,d,a,k[3],22,-1044525330);a=ff(a,b,c,d,k[4],7,-176418897);d=ff(d,a,b,c,k[5],12,1200080426);c=ff(c,d,a,b,k[6],17,-1473231341);b=ff(b,c,d,a,k[7],22,-45705983);a=ff(a,b,c,d,k[8],7,1770035416);d=ff(d,a,b,c,k[9],12,-1958414417);c=ff(c,d,a,b,k[10],17,-42063);b=ff(b,c,d,a,k[11],22,-1990404162);a=ff(a,b,c,d,k[12],7,1804603682);d=ff(d,a,b,c,k[13],12,-40341101);c=ff(c,d,a,b,k[14],17,-1502002290);b=ff(b,c,d,a,k[15],22,1236535329);a=gg(a,b,c,d,k[1],5,-165796510);d=gg(d,a,b,c,k[6],9,-1069501632);c=gg(c,d,a,b,k[11],14,643717713);b=gg(b,c,d,a,k[0],20,-373897302);a=gg(a,b,c,d,k[5],5,-701558691);d=gg(d,a,b,c,k[10],9,38016083);c=gg(c,d,a,b,k[15],14,-660478335);b=gg(b,c,d,a,k[4],20,-405537848);a=gg(a,b,c,d,k[9],5,568446438);d=gg(d,a,b,c,k[14],9,-1019803690);c=gg(c,d,a,b,k[3],14,-187363961);b=gg(b,c,d,a,k[8],20,1163531501);a=gg(a,b,c,d,k[13],5,-1444681467);d=gg(d,a,b,c,k[2],9,-51403784);c=gg(c,d,a,b,k[7],14,1735328473);b=gg(b,c,d,a,k[12],20,-1926607734);a=hh(a,b,c,d,k[5],4,-378558);d=hh(d,a,b,c,k[8],11,-2022574463);c=hh(c,d,a,b,k[11],16,1839030562);b=hh(b,c,d,a,k[14],23,-35309556);a=hh(a,b,c,d,k[1],4,-1530992060);d=hh(d,a,b,c,k[4],11,1272893353);c=hh(c,d,a,b,k[7],16,-155497632);b=hh(b,c,d,a,k[10],23,-1094730640);a=hh(a,b,c,d,k[13],4,681279174);d=hh(d,a,b,c,k[0],11,-358537222);c=hh(c,d,a,b,k[3],16,-722521979);b=hh(b,c,d,a,k[6],23,76029189);a=hh(a,b,c,d,k[9],4,-640364487);d=hh(d,a,b,c,k[12],11,-421815835);c=hh(c,d,a,b,k[15],16,530742520);b=hh(b,c,d,a,k[2],23,-995338651);a=ii(a,b,c,d,k[0],6,-198630844);d=ii(d,a,b,c,k[7],10,1126891415);c=ii(c,d,a,b,k[14],15,-1416354905);b=ii(b,c,d,a,k[5],21,-57434055);a=ii(a,b,c,d,k[12],6,1700485571);d=ii(d,a,b,c,k[3],10,-1894986606);c=ii(c,d,a,b,k[10],15,-1051523);b=ii(b,c,d,a,k[1],21,-2054922799);a=ii(a,b,c,d,k[8],6,1873313359);d=ii(d,a,b,c,k[15],10,-30611744);c=ii(c,d,a,b,k[6],15,-1560198380);b=ii(b,c,d,a,k[13],21,1309151649);a=ii(a,b,c,d,k[4],6,-145523070);d=ii(d,a,b,c,k[11],10,-1120210379);c=ii(c,d,a,b,k[2],15,718787259);b=ii(b,c,d,a,k[9],21,-343485551);x[0]=add32(a,x[0]);x[1]=add32(b,x[1]);x[2]=add32(c,x[2]);x[3]=add32(d,x[3]);}
  function cmn(q,a,b,x,s,t){a=add32(add32(a,q),add32(x,t));return add32((a<<s)|(a>>>(32-s)),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
  function md5blk(s){var md5blks=[],i;for(i=0;i<64;i+=4){md5blks[i>>2]=s.charCodeAt(i)+(s.charCodeAt(i+1)<<8)+(s.charCodeAt(i+2)<<16)+(s.charCodeAt(i+3)<<24);}return md5blks;}
  function md51(s){var n=s.length,state=[1732584193,-271733879,-1732584194,271733878],i,len,tail,lo,hi;for(i=64;i<=n;i+=64){md5cycle(state,md5blk(s.substring(i-64,i)));}s=s.substring(i-64);len=s.length;tail=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(i=0;i<len;i++){tail[i>>2]|=s.charCodeAt(i)<<((i%4)<<3);}tail[i>>2]|=0x80<<((i%4)<<3);if(i>55){md5cycle(state,tail);for(i=0;i<16;i++)tail[i]=0;}var tmp=n*8;tmp=tmp.toString(16).match(/(.*?)(.{0,8})$/);lo=parseInt(tmp[2],16);hi=parseInt(tmp[1],16)||0;tail[14]=lo;tail[15]=hi;md5cycle(state,tail);return state;}
  function add32(a,b){return(a+b)&0xFFFFFFFF;}
  function byteHex(v){return ((v>>>4)&0xF).toString(16)+(v&0xF).toString(16);}
  function hex(x){var h='';for(var i=0;i<x.length;i++){var n=x[i];h+=byteHex(n&0xFF)+byteHex((n>>>8)&0xFF)+byteHex((n>>>16)&0xFF)+byteHex((n>>>24)&0xFF);}return h;}
  return hex(md51(s));
};
function fmSign(params) {
  var filtered={},keys=[];
  for(var k in params){if(params.hasOwnProperty(k)&&params[k]!==null&&params[k]!==''){filtered[k]=String(params[k]);keys.push(k);}}
  keys.sort();var raw='';
  for(var i=0;i<keys.length;i++){raw+=keys[i]+filtered[keys[i]]+SALT;}
  var d=md5(raw),chars=d.split(''),result=[],i=0,j=chars.length-1;
  while(i<j){result.push((parseInt(chars[i],16)^parseInt(chars[j],16)).toString(16));i++;j--;}
  result.push(chars.slice(i).join(''));return result.join('');
}
function extractEmail(data){
  if(!data||!data.data||!data.data.list)return'';
  var l=data.data.list;
  for(var i=0;i<l.length;i++){if(l[i].name==='email'&&l[i].has&&l[i].id)return l[i].id;}
  return'';
}

(async function(){
  var prev = window.__emailResults || [];
  var todo = [];
  for (var i = 0; i < prev.length; i++) {
    if (!prev[i].email || prev[i].email === 'NONE') {
      todo.push(prev[i]);
    }
  }
  if (!todo.length) {
    console.log('All done! No missing emails.');
    return;
  }
  console.log('Retrying ' + todo.length + ' missing...');
  var newly = 0;
  for (var idx = 0; idx < todo.length; idx++) {
    var t = todo[idx];
    var uid = t.uid;
    var params = {uid: uid, _time: String(Math.floor(Date.now()/1000)), cnonce: String(Math.floor(Math.random()*100000000))};
    var sign = fmSign(params);
    var url = '/api/author/v3/detail/authorContact?uid='+uid+'&_time='+params._time+'&cnonce='+params.cnonce;
    try {
      var resp = await fetch(url, {headers:{'fm-sign':sign,'accept':'application/json','region':'ES','lang':'ZH_CN','source':'pc'}});
      var data = await resp.json();
      if (data.code === 200) {
        var email = extractEmail(data);
        // Update both todo and prev arrays
        todo[idx].email = email || 'NONE';
        todo[idx].ok = true;
        delete todo[idx].error;
        // Also update the original entry in prev
        for (var p = 0; p < prev.length; p++) {
          if (prev[p].uid === uid) { prev[p].email = email || 'NONE'; prev[p].ok = true; delete prev[p].error; break; }
        }
        if (email) newly++;
        console.log('[' + (idx+1) + '/' + todo.length + '] ' + t.username + ' -> ' + (email || 'NONE'));
      } else {
        console.log('[' + (idx+1) + '/' + todo.length + '] ' + t.username + ' -> ERR: ' + (data.msg || data.code));
        if (data.code === 'MSG_SAFE_0001' || data.msg === 'MSG_SAFE_0001') {
          console.log('Hit rate limit, saving progress and stopping...');
          break;
        }
      }
    } catch(e) {
      console.log('[' + (idx+1) + '/' + todo.length + '] ' + t.username + ' -> ERR: ' + e.message);
    }
    await new Promise(function(r) { setTimeout(r, 2000 + Math.random() * 1000); });
  }
  var final = prev.filter(function(r) { return r.email && r.email !== 'NONE'; });
  console.log('\nDone: ' + final.length + '/' + prev.length + ' have email');
  var blob = new Blob([JSON.stringify(prev, null, 2)], {type:'application/json'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fastmoss_es_emails_final.json';
  a.click();
  console.log('Downloaded');
})();
})();
