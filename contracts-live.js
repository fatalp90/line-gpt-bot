// Group-scoped live test bridge. No customer data is placed in a public URL.
(async()=>{
 let token='';let version='0',last=null,busy=false,role='',dirty=false;
 document.querySelector('main').hidden=true;document.querySelectorAll('dialog').forEach(d=>d.close());
 const banner=document.createElement('div');banner.className='callout';banner.style.margin='20px';banner.textContent='กำลังเชื่อมต่อ 그룹 연결 중';document.querySelector('header').after(banner);
 async function api(action,extra={}){const r=await fetch('/api/contracts',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,...extra})});const data=await r.json();if(!r.ok)throw Error(data.error||'Connection failed');return data}
 async function task(fn){if(busy)return;busy=true;try{await fn()}catch(e){toast(e.message)}finally{busy=false}}
 const html=(th,ko)=>'<span class="bilingual">'+th+'<small class="ko">'+ko+'</small></span>';
 function result(s){version=s.version;last=s;state.completed=s.completed;state.contract=s.signed?{customerName:s.signed.details?.customerName||s.data.name}:null;state.requested=!!s.request;state.renewal=null;update();$('customer').hidden=true;$('renewal-open').hidden=true;$('renewal-send').disabled=false;$('request').disabled=false;if(s.folderUrl){banner.innerHTML=html('บันทึกใน Google Drive แล้ว','구글 드라이브에 저장 중');const a=document.createElement('a');a.textContent=' เปิดโฟลเดอร์ · 저장 폴더';a.href=s.folderUrl;a.target='_blank';a.rel='noopener';banner.append(a)}for(const k of ['photos','videos']){let el=document.getElementById('saved-'+k);if(!el){el=document.createElement('div');el.id='saved-'+k;el.className='hint';$('pane-'+k).append(el)}const count=(s.files||[]).filter(f=>f.kind===k).length;$(k==='photos'?'photo-count':'video-count').textContent=count;$(k==='photos'?'photo-label':'video-label').textContent=(k==='photos'?'รูปภาพ / 사진 ':'วิดีโอ / 영상 ')+count+' · บันทึกแล้ว / 저장됨';el.textContent='บันทึกแล้ว / 저장됨: '+(s.files||[]).filter(f=>f.kind===k).map(f=>f.name).join(', ')}const out=s.request?.kind==='renewal'?$('renewal-result'):$('contract-result');$('renewal-result').replaceChildren();$('contract-result').replaceChildren();if(s.signed){const box=document.createElement('div');box.className='paper';const title=document.createElement('b');title.textContent='✓ ลงลายเซ็นแล้ว · 서명 저장 완료';const text=document.createElement('p');text.textContent=s.request.document;text.style.whiteSpace='pre-line';const img=document.createElement('img');img.alt='ลายเซ็น';img.style.cssText='width:100%;height:100px;object-fit:contain';img.src=s.signed.signature;box.append(title,text,img);out.append(box);out.hidden=false} $('renewal-status').innerHTML=html(s.request?.kind==='renewal'?(s.signed?'ลงลายเซ็นแล้ว':'รอลูกค้าลงลายเซ็น'):'ยังไม่ได้ส่งคำขอ',s.request?.kind==='renewal'?(s.signed?'서명 완료':'고객 서명 대기'):'발송 전');}
 async function load(){const s=await api('load');result(s);return s}
 info.addEventListener('input',()=>{dirty=true});
 async function save(){if(!valid()){tab('check');valid(true);throw Error('กรอกข้อมูลให้ครบ · 필수정보를 입력해주세요')}const s=await api('save',{base:version,data:get()});dirty=false;result(s);return s}
 function signature(c){const small=document.createElement('canvas');small.width=600;small.height=192;small.getContext('2d').drawImage(c,0,0,600,192);return small.toDataURL('image/png')}
 try{
 const customerToken=location.hash.slice(1);
 if(customerToken){token=customerToken;history.replaceState(null,'',location.pathname)}else{
 const config=await (await fetch('/api/contracts')).json();
 await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://static.line-scdn.net/liff/edge/2/sdk.js';script.onload=resolve;script.onerror=()=>reject(Error('LINE login unavailable'));document.head.append(script)});
 await liff.init({liffId:config.liffId});
 if(!liff.isLoggedIn()){liff.login({redirectUri:location.href});return}
 const entry=new URL(location.href).searchParams.get('entry');
 if(!entry)throw Error('กรุณาเปิดลิงก์จากกลุ่ม LINE · 그룹방의 관리자 입력폼 버튼으로 열어주세요.');
 token=entry;const exchanged=await api('exchange',{idToken:liff.getIDToken()});token=exchanged.token;
 }
 const s=await api('load');role=s.role;
 if(role==='admin'){
 document.querySelector('main').hidden=false;banner.innerHTML=html('ทดสอบจริงผ่าน LINE / ใช้ข้อมูลสมมติเท่านั้น','입력정보·계약서·서명·첨부는 전용 구글 드라이브 폴더에 저장됩니다. 가상정보로 테스트해주세요.');
 if(s.data)Object.entries(s.data).forEach(([k,v])=>{if(fields[k])fields[k].value=v});renderRenewal();result(s);
 $('pane-check').querySelector('.callout').innerHTML=html('กรอกจำนวนเงินเป็นวอน ระบบใช้กลุ่มที่ส่งคำสั่ง /관리자','금액은 원 단위이며 명령어를 사용한 그룹에 연결됩니다.');
 $('pane-check').querySelector('p.hint').innerHTML=html('กดบันทึกเพื่อเก็บข้อมูลในเซิร์ฟเวอร์ ลายเซ็นที่ส่งแล้วจะถูกเก็บไว้','저장 버튼으로 서버에 저장하며 제출된 서명도 보관됩니다.');
 $('pane-contract').querySelector('.callout').innerHTML=html('ส่งปุ่มให้ลูกค้าในกลุ่ม LINE จริง ใช้ข้อมูลสมมติสำหรับทดสอบเท่านั้น','해당 LINE 그룹에 실제 서명 버튼을 보냅니다. 가상정보로 테스트해주세요.');
 $('pane-renewal').querySelectorAll('p.hint')[1].innerHTML=html('ส่งปุ่มลงลายเซ็นไปยังกลุ่ม LINE และบันทึกผลใน Google Drive','LINE 그룹에 서명 버튼을 보내고 결과를 구글 드라이브에 저장합니다.');
 document.querySelector('.aside p.hint').innerHTML=html('ส่งคำขอ Check Over ไปยังกลุ่มผู้ดูแล กดลงทะเบียนเพื่อบันทึกในชีต','완료하기를 누르면 관리자 확인방에 체크오버 등록 카드가 전송됩니다. 카드에서 등록하면 원본시트에 반영됩니다.');
 $('demo').hidden=true;$('reset').hidden=true;$('customer').hidden=true;$('renewal-open').hidden=true;
 $('save').innerHTML=html('บันทึกข้อมูล','서버에 저장');$('save').onclick=()=>task(async()=>{await save();toast('บันทึกแล้ว · 저장 완료')});
 $('next').onclick=()=>task(async()=>{await save();tab('contract')});
 for(const [id,kind] of [['request','new'],['renewal-send','renewal']])$(id).onclick=()=>task(async()=>{await save();await api('request',{base:version,kind});await load();toast('ส่งปุ่มลงลายเซ็นไปยังกลุ่มลูกค้า แล้ว · 해당 그룹에 서명 버튼을 보냈어요.')});
 $('complete').onclick=()=>task(async()=>{await save();await api('complete',{base:version});await load();toast('ส่งคำขอ Check Over แล้ว · 관리자 확인방에 체크오버 등록 요청을 보냈어요.')});
 for(const k of ['photos','videos']){const note=$('pane-'+k).querySelector('p.hint');note.innerHTML=html('เลือกไฟล์เพื่ออัปโหลดไปยัง Google Drive กรุณารอจนเสร็จ','파일 선택 시 구글 드라이브로 업로드합니다. 완료될 때까지 화면을 유지해주세요.');$(k).onchange=e=>{const files=[...e.target.files];e.target.value='';task(async()=>{await save();for(const file of files){const u=await api('uploadStart',{kind:k,name:file.name,mime:file.type,size:file.size});for(let offset=0;offset<file.size;){const chunk=file.slice(offset,offset+u.chunkSize);const bytes=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(chunk)});const r=await api('uploadChunk',{uploadId:u.uploadId,offset,bytes});if(r.offset<=offset)throw Error('Upload stopped');offset=r.offset;note.textContent=file.name+' · '+Math.round(offset/file.size*100)+'%';}await load();}note.innerHTML=html('อัปโหลดเสร็จแล้ว','드라이브 저장 완료')})};}
 document.querySelector('.notice').innerHTML=html('ลายเซ็นยังเป็นการทดสอบ การกดลงทะเบียน Check Over จะบันทึกในชีตจริง','서명은 본인인증 없는 테스트용입니다. 체크오버 등록 카드에서 승인하면 원본시트에 실제 반영됩니다.');
 setInterval(()=>{if(!busy&&!dirty&&!document.hidden)task(load)},15000);
 }else{
 banner.innerHTML=html('ทดสอบเท่านั้น ไม่ใช่สัญญาจริง','그룹 테스트 전용 · 고객 본인인증이 적용되지 않은 서명 체험입니다.');
 if(s.signed){banner.textContent='✓ ส่งลายเซ็นแล้ว · 서명이 이미 제출됐습니다.';return}
 const renew=s.request.kind==='renewal',dialog=$(renew?'renewal-dialog':'customer-dialog'),doc=$(renew?'renewal-document':'customer-summary'),form=$(renew?'renewal-form':'customer-form');
 doc.textContent=s.request.document;doc.style.whiteSpace='pre-line';form.reset();if(!renew)form.elements.customerName.value=s.request.data.name;
 dialog.querySelector('[data-close]').hidden=true;dialog.addEventListener('cancel',e=>e.preventDefault());dialog.showModal();
 form.onsubmit=e=>{e.preventDefault();task(async()=>{if(!(renew?rs:hasSign))throw Error('กรุณาลงลายเซ็น · 서명을 작성해주세요');await api('sign',{consent:true,signature:signature(renew?rc:canvas),details:renew?{}:Object.fromEntries(new FormData(form))});dialog.close();banner.textContent='✓ ส่งลายเซ็นแล้ว ขอบคุณค่ะ · 서명 제출이 완료됐습니다.'})};
 }
 }catch(e){banner.textContent=e.message}
})();
