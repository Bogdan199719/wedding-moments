const galleryMedia=document.querySelector("#gallery-media");
const cameraPhoto=document.querySelector("#photo-camera");
const cameraVideo=document.querySelector("#video-camera");
const nameInput=document.querySelector("#guest-name");
const pickerNote=document.querySelector("#picker-note");
const pickerStatus=document.querySelector("#picker-status");
const queue=document.querySelector("#queue");
const statusEl=document.querySelector("#status");
const percent=document.querySelector("#percent");
const bar=document.querySelector("#bar");
const previews=document.querySelector("#previews");
const savedHeading=document.querySelector("#saved-heading");
const savedCount=document.querySelector("#saved-count");
const cancel=document.querySelector("#cancel");
const retry=document.querySelector("#retry");
const successActions=document.querySelector("#success-actions");
const successTitle=document.querySelector("#success-title");
const successCopy=document.querySelector("#success-copy");
const viewer=document.querySelector("#media-viewer");
const viewerContent=document.querySelector("#viewer-content");
const viewerClose=document.querySelector("#viewer-close");

const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const MAX_FILE_BYTES=1024*1024*1024;
const MAX_RETRIES=5;
let activeBatch=null;
let requestController=null;
let savedTotal=0;
let retryTimer=null;
let retryWake=null;
let activePicker=null;
let pickerOpenedAt=0;

const makeId=()=>crypto.randomUUID?.()??"10000000-1000-4000-8000-100000000000".replace(/[018]/g,char=>(Number(char)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(char)/4).toString(16));

if(isIOS)pickerNote.textContent="На iPhone можно отметить сразу несколько фото и видео. Оригиналы загрузятся по очереди без сжатия, а после обрыва загрузка продолжится автоматически.";

function requireName(event){
  if(nameInput.value.trim())return true;
  event?.preventDefault();
  nameInput.setCustomValidity("Сначала укажите ваше имя");
  nameInput.reportValidity();
  nameInput.focus();
  return false;
}

function formatBytes(bytes){
  if(bytes<1024*1024)return`${Math.max(1,Math.round(bytes/1024))} КБ`;
  return`${(bytes/1024/1024).toFixed(bytes>=100*1024*1024?0:1)} МБ`;
}

function mediaCard(file){
  const card=document.createElement("article");
  card.className="preview-card is-uploading";
  const isVideo=file.type.startsWith("video");
  const mediaWrap=document.createElement("div");
  mediaWrap.className="preview-media";
  let url=null;
  if(isVideo&&(isIOS||file.size>50*1024*1024)){
    const placeholder=document.createElement("div");
    placeholder.className="preview-placeholder";
    placeholder.innerHTML='<i class="ph ph-video-camera" aria-hidden="true"></i>';
    mediaWrap.append(placeholder);
  }else{
    const media=document.createElement(isVideo?"video":"img");
    url=URL.createObjectURL(file);
    media.src=url;
    media.alt=`Предпросмотр: ${file.name||"файл с камеры"}`;
    if(isVideo){media.playsInline=true;media.preload="metadata"}
    else media.decoding="async";
    mediaWrap.append(media);
    if(isVideo){
      const open=document.createElement("button");
      open.className="open-preview";
      open.type="button";
      open.setAttribute("aria-label",`Открыть видео ${file.name||"с камеры"}`);
      open.innerHTML='<i class="ph-fill ph-play" aria-hidden="true"></i>';
      open.addEventListener("click",()=>openViewer(url,file.name||"Видео"));
      mediaWrap.append(open);
    }
  }
  const info=document.createElement("div");
  info.className="preview-info";
  const name=document.createElement("strong");
  name.textContent=file.name||"Файл с камеры";
  const state=document.createElement("span");
  state.textContent=`Подготовка · ${formatBytes(file.size)}`;
  info.append(name,state);
  card.append(mediaWrap,info);
  previews.append(card);
  return{card,state,url};
}

function showSelectionError(message){
  pickerStatus.textContent=message;
  queue.hidden=false;
  statusEl.textContent=message;
  percent.textContent="";
  bar.style.width="0";
  cancel.hidden=true;
  retry.hidden=true;
}

function choose(fileList){
  const files=[...fileList];
  if(!requireName()||!files.length||activeBatch)return;
  const tooLarge=files.find(file=>file.size>MAX_FILE_BYTES);
  if(tooLarge){showSelectionError(`${tooLarge.name}: файл больше 1 ГБ. Добавьте более короткое видео.`);return}
  pickerStatus.textContent="";
  const items=files.map(file=>({file,size:file.size,...mediaCard(file),session:null,sessionId:makeId(),saved:false}));
  activeBatch={items,index:0,uploadId:makeId(),completedBytes:0,totalBytes:files.reduce((sum,file)=>sum+file.size,0),cancelled:false,running:false};
  queue.hidden=false;
  savedHeading.hidden=savedTotal===0;
  cancel.hidden=false;
  retry.hidden=true;
  successActions.hidden=true;
  setInputsDisabled(true);
  void processBatch();
}

async function fetchTimed(url,options={},timeoutMs=180000){
  if(activeBatch?.cancelled)throw cancelledError();
  const controller=new AbortController();
  requestController=controller;
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal})}
  catch(error){if(activeBatch?.cancelled)throw cancelledError();throw error}
  finally{clearTimeout(timer);if(requestController===controller)requestController=null}
}

async function responseError(response,fallback="Не удалось загрузить файл"){
  try{return(await response.json()).error||fallback}catch{return fallback}
}

async function createSession(item){
  const response=await fetchTimed("/api/upload-sessions",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({sessionId:item.sessionId,uploadId:activeBatch.uploadId,name:item.file.name||"file",type:item.file.type||"application/octet-stream",size:item.file.size,guestName:nameInput.value.trim()}),
  });
  if(!response.ok)throw new Error(await responseError(response,"Не удалось начать загрузку"));
  item.session=await response.json();
  return item.session;
}

async function readOffset(item){
  const response=await fetchTimed(`/api/upload-sessions/${encodeURIComponent(item.session.id)}`,{method:"HEAD",headers:{"x-upload-token":item.session.token}},45000);
  if(!response.ok)throw Object.assign(new Error("Сессия загрузки недоступна"),{status:response.status});
  return Number(response.headers.get("Upload-Offset")||0);
}

function sleep(ms){
  return new Promise((resolve,reject)=>{
    retryTimer=setTimeout(()=>{retryTimer=null;retryWake=null;resolve()},ms);
    retryWake=()=>{clearTimeout(retryTimer);retryTimer=null;retryWake=null;reject(cancelledError())};
  });
}

function cancelledError(){return Object.assign(new Error("Загрузка отменена"),{name:"UploadCancelled"})}

async function sendChunk(item,offset,chunk){
  for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
    try{
      const response=await fetchTimed(`/api/upload-sessions/${encodeURIComponent(item.session.id)}`,{
        method:"PATCH",
        headers:{"content-type":"application/offset+octet-stream","x-upload-token":item.session.token,"Upload-Offset":String(offset)},
        body:chunk,
      });
      if(response.ok)return Number(response.headers.get("Upload-Offset")||offset+chunk.size);
      if(response.status===409)return await readOffset(item);
      if(response.status!==408&&response.status!==425&&response.status!==429&&response.status<500)throw new Error(await responseError(response));
    }catch(error){
      if(error.name==="UploadCancelled")throw error;
      if(attempt===MAX_RETRIES)throw error;
    }
    statusEl.textContent=`Связь прервалась — продолжаем автоматически (${attempt}/${MAX_RETRIES})…`;
    await sleep(Math.min(1000*2**(attempt-1),8000));
    try{return await readOffset(item)}catch(error){if(error.name==="UploadCancelled")throw error}
  }
  throw new Error("Не удалось продолжить загрузку");
}

async function completeSession(item){
  let lastError;
  for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
    try{
      const response=await fetchTimed(`/api/upload-sessions/${encodeURIComponent(item.session.id)}/complete`,{method:"POST",headers:{"x-upload-token":item.session.token}},180000);
      if(response.ok)return await response.json();
      if(response.status<500&&response.status!==429)throw new Error(await responseError(response,"Не удалось проверить файл"));
      lastError=new Error(await responseError(response));
    }catch(error){if(error.name==="UploadCancelled")throw error;lastError=error}
    if(attempt<MAX_RETRIES)await sleep(Math.min(1000*2**(attempt-1),8000));
  }
  throw lastError||new Error("Не удалось завершить загрузку");
}

function updateProgress(item,offset){
  const progress=Math.min(100,Math.round((activeBatch.completedBytes+offset)/activeBatch.totalBytes*100));
  const fileProgress=Math.min(100,Math.round(offset/item.size*100));
  bar.style.width=`${progress}%`;
  percent.textContent=`${progress}%`;
  statusEl.textContent=activeBatch.items.length===1?"Загружаем оригинал…":`Загружаем файл ${activeBatch.index+1} из ${activeBatch.items.length}…`;
  item.state.textContent=`Загружается · ${fileProgress}%`;
}

async function uploadItem(item){
  if(!item.session)await createSession(item);
  let offset;
  try{offset=await readOffset(item)}catch(error){
    if(error.status===404||error.status===410){item.session=null;await createSession(item);offset=0}else throw error;
  }
  updateProgress(item,offset);
  while(offset<item.size){
    const end=Math.min(offset+item.session.chunkSize,item.size);
    offset=await sendChunk(item,offset,item.file.slice(offset,end));
    updateProgress(item,offset);
  }
  return await completeSession(item);
}

async function processBatch(){
  const batch=activeBatch;
  if(!batch||batch.running)return;
  batch.running=true;
  try{
    for(;batch.index<batch.items.length;batch.index++){
      const item=batch.items[batch.index];
      if(item.saved)continue;
      const result=await uploadItem(item);
      item.saved=true;
      markSaved(item,result);
      batch.completedBytes+=item.size;
      savedTotal+=1;
      savedHeading.hidden=false;
      savedCount.textContent=`${savedTotal} ${fileWord(savedTotal)}`;
    }
    bar.style.width="100%";
    percent.textContent="✓";
    statusEl.textContent=savedTotal===1?"Файл успешно сохранён":`${savedTotal} ${fileWord(savedTotal)} успешно сохранено`;
    cancel.hidden=true;
    retry.hidden=true;
    successTitle.textContent="Спасибо!";
    successCopy.textContent="Всё уже сохранено в оригинальном качестве. Больше ничего делать не нужно.";
    successActions.hidden=false;
    activeBatch=null;
    setInputsDisabled(false);
    successActions.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"nearest"});
  }catch(error){
    batch.running=false;
    if(error.name==="UploadCancelled")return;
    finishFailure(error.message||"Не удалось загрузить. Проверьте соединение и попробуйте снова.");
  }
}

function markSaved(item,result){
  item.card.classList.remove("is-uploading");
  item.card.classList.add("is-saved");
  item.state.textContent=result.duplicate?"Уже было сохранено ранее":"Сохранено в оригинальном качестве";
  if(!result.deleteToken)return;
  const remove=document.createElement("button");
  remove.className="remove-file";
  remove.type="button";
  remove.setAttribute("aria-label",`Удалить ${result.name}`);
  remove.innerHTML='<i class="ph ph-x" aria-hidden="true"></i>';
  remove.addEventListener("click",()=>removeSaved(result,item,remove));
  item.card.append(remove);
}

async function removeSaved(result,item,button){
  if(!confirm("Удалить этот файл? Его можно будет выбрать заново."))return;
  button.disabled=true;
  try{
    const response=await fetch(`/api/uploads/${encodeURIComponent(result.id)}`,{method:"DELETE",headers:{"x-delete-token":result.deleteToken}});
    if(!response.ok)throw new Error();
    if(item.url)URL.revokeObjectURL(item.url);
    item.card.remove();
    savedTotal=Math.max(0,savedTotal-1);
    savedCount.textContent=savedTotal?`${savedTotal} ${fileWord(savedTotal)}`:"";
    savedHeading.hidden=savedTotal===0;
    statusEl.textContent=savedTotal?"Остальные файлы сохранены":"Файл удалён — можно выбрать новый";
    percent.textContent=savedTotal?"✓":"";
    successTitle.textContent=savedTotal?"Спасибо!":"Файл удалён";
    successCopy.textContent=savedTotal?"Остальные файлы по-прежнему сохранены.":"Можно выбрать новый файл.";
  }catch{button.disabled=false;statusEl.textContent="Не удалось удалить файл. Проверьте соединение и попробуйте ещё раз."}
}

function finishFailure(message){
  statusEl.textContent=message;
  percent.textContent="";
  bar.style.width="0";
  cancel.hidden=true;
  retry.hidden=!activeBatch;
  setInputsDisabled(false);
}

function clearPending(batch){
  batch?.items.filter(item=>!item.saved).forEach(item=>{
    if(item.url)URL.revokeObjectURL(item.url);
    item.card.remove();
  });
}

async function cancelBatch(){
  const batch=activeBatch;
  if(!batch)return;
  batch.cancelled=true;
  requestController?.abort();
  retryWake?.();
  const current=batch.items[batch.index];
  if(current?.session&&!current.saved){
    void fetch(`/api/upload-sessions/${encodeURIComponent(current.session.id)}`,{method:"DELETE",headers:{"x-upload-token":current.session.token}}).catch(()=>{});
  }
  clearPending(batch);
  activeBatch=null;
  statusEl.textContent="Загрузка отменена.";
  percent.textContent="";
  bar.style.width="0";
  cancel.hidden=true;
  retry.hidden=true;
  successActions.hidden=savedTotal===0;
  setInputsDisabled(false);
}

function setInputsDisabled(disabled){document.querySelectorAll("[data-input]").forEach(button=>button.disabled=disabled)}

function fileWord(count){
  const mod10=count%10,mod100=count%100;
  if(mod10===1&&mod100!==11)return"файл";
  if(mod10>=2&&mod10<=4&&(mod100<12||mod100>14))return"файла";
  return"файлов";
}

function pickerFailed(){
  if(!activePicker)return;
  const waited=Date.now()-pickerOpenedAt;
  activePicker=null;
  if(waited<4000)return;
  pickerStatus.textContent=isIOS
    ?"Медиатека не передала выбранные файлы. Если рядом с ними значок облака — сначала откройте их в приложении «Фото» и дождитесь загрузки оригиналов из iCloud, затем повторите выбор."
    :"Выбор файла был отменён. Попробуйте снова или выберите меньше файлов.";
}

function openViewer(url,name){
  const player=document.createElement("video");
  player.src=url;player.controls=true;player.autoplay=true;player.playsInline=true;
  player.setAttribute("controlslist","nodownload noremoteplayback");player.disablePictureInPicture=true;player.setAttribute("aria-label",name);
  viewerContent.replaceChildren(player);viewer.hidden=false;document.body.classList.add("viewer-open");
}

function closeViewer(){
  const player=viewerContent.querySelector("video");player?.pause();viewerContent.replaceChildren();viewer.hidden=true;document.body.classList.remove("viewer-open");
}

for(const input of[galleryMedia,cameraPhoto,cameraVideo]){
  input.addEventListener("change",()=>{
    activePicker=null;
    pickerStatus.textContent="";
    if(input.files?.length)choose(input.files);
    input.value="";
  });
  input.addEventListener("cancel",pickerFailed);
}

for(const button of document.querySelectorAll("[data-input]")){
  button.addEventListener("click",event=>{
    if(!requireName(event)||activeBatch)return;
    const input=document.querySelector(`#${button.dataset.input}`);
    input.value="";
    activePicker=input;
    pickerOpenedAt=Date.now();
    pickerStatus.textContent=isIOS?"Медиатека готовит оригинал. Для большого видео это может занять некоторое время…":"";
    input.click();
  });
}

window.addEventListener("focus",()=>{
  if(!activePicker)return;
  setTimeout(()=>{if(activePicker)pickerFailed()},1200);
});
nameInput.addEventListener("input",()=>nameInput.setCustomValidity(""));
cancel.addEventListener("click",()=>void cancelBatch());
retry.addEventListener("click",()=>{
  if(!activeBatch)return;
  activeBatch.cancelled=false;
  activeBatch.running=false;
  retry.hidden=true;
  cancel.hidden=false;
  setInputsDisabled(true);
  void processBatch();
});
viewerClose.addEventListener("click",closeViewer);
viewer.addEventListener("click",event=>{if(event.target===viewer)closeViewer()});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!viewer.hidden)closeViewer()});
