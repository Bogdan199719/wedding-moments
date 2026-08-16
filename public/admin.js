const login=document.querySelector("#login"),dashboard=document.querySelector("#dashboard"),form=document.querySelector("#login-form"),error=document.querySelector("#login-error"),grid=document.querySelector("#grid"),order=document.querySelector("#order");
const galleryPanel=document.querySelector("#gallery-panel"),galleryStatus=document.querySelector("#gallery-status"),galleryDescription=document.querySelector("#gallery-description"),galleryToggle=document.querySelector("#gallery-toggle"),galleryOpen=document.querySelector("#gallery-open"),galleryCopyLink=document.querySelector("#gallery-copy-link");
const deleteAll=document.querySelector("#delete-all"),adminStatus=document.querySelector("#admin-status");
let mediaCount=0;
const bytes=n=>n<1024?n+" Б":n<1048576?(n/1024).toFixed(1)+" КБ":n<1073741824?(n/1048576).toFixed(1)+" МБ":(n/1073741824).toFixed(1)+" ГБ";
async function load(){
  const response=await fetch("/api/admin/media?order="+order.value);
  if(!response.ok){login.hidden=false;dashboard.hidden=true;return}
  const data=await response.json();
  login.hidden=true;
  dashboard.hidden=false;
  document.querySelector("#count").textContent=data.stats.count;
  document.querySelector("#size").textContent=bytes(data.stats.bytes);
  mediaCount=Number(data.stats.count)||0;
  deleteAll.disabled=mediaCount===0;
  document.querySelector("#empty").hidden=data.items.length>0;
  void loadGallery();
  grid.innerHTML="";
  for(const item of data.items){
    const card=document.createElement("article");
    card.className="item";
    const media=document.createElement(item.media_type==="photo"?"img":"video");
    media.src="/api/admin/media/"+item.id;
    if(media.tagName==="VIDEO"){
      media.controls=true;
      media.preload="metadata";
      media.playsInline=true;
    }else{
      media.loading="lazy";
      media.alt=item.original_name;
    }
    const meta=document.createElement("div");
    meta.className="meta";
    meta.innerHTML=`<strong></strong><span class="guest"></span><span>${bytes(item.size)} · ${new Date(item.created_at).toLocaleString("ru-RU")}</span><div class="actions"><a class="open">Открыть оригинал</a><a class="download">Скачать</a><button>Удалить</button></div>`;
    meta.querySelector("strong").textContent=item.original_name;
    meta.querySelector(".guest").textContent="Автор: "+item.guest_name+" · ";
    meta.querySelector(".open").href=media.src;
    meta.querySelector(".open").target="_blank";
    meta.querySelector(".open").rel="noopener";
    meta.querySelector(".download").href=media.src;
    meta.querySelector(".download").download="";
    meta.querySelector("button").onclick=async()=>{
      if(confirm("Удалить этот файл без возможности восстановления?")){
        await fetch(media.src,{method:"DELETE"});
        load();
      }
    };
    card.append(media,meta);
    grid.append(card);
  }
}
function renderGallery(enabled,url="/gallery"){
  galleryPanel.classList.toggle("is-enabled",enabled);
  galleryStatus.textContent=enabled?"Открыта для гостей":"Скрыта от гостей";
  galleryDescription.textContent=enabled?"Все загруженные фото и видео доступны по публичной ссылке.":"Включите раздел, когда будете готовы показать гостям общую коллекцию.";
  galleryToggle.textContent=enabled?"Скрыть галерею":"Включить галерею";
  galleryToggle.dataset.enabled=String(enabled);
  galleryToggle.disabled=false;
  galleryCopyLink.disabled=!enabled;
  galleryOpen.href=url;
}
async function loadGallery(){
  galleryToggle.disabled=true;
  try{
    const response=await fetch("/api/admin/gallery",{headers:{accept:"application/json"}});
    if(!response.ok)throw new Error();
    const data=await response.json();
    renderGallery(Boolean(data.enabled),data.url);
  }catch{
    galleryStatus.textContent="Не удалось проверить";
    galleryDescription.textContent="Обновите страницу и попробуйте ещё раз.";
  }
}
galleryToggle.addEventListener("click",async()=>{
  const next=galleryToggle.dataset.enabled!=="true";
  galleryToggle.disabled=true;
  galleryStatus.textContent=next?"Открываем…":"Скрываем…";
  try{
    const response=await fetch("/api/admin/gallery",{method:"PUT",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({enabled:next})});
    if(!response.ok)throw new Error();
    const data=await response.json();
    renderGallery(Boolean(data.enabled),data.url);
  }catch{
    galleryStatus.textContent="Не удалось изменить";
    galleryToggle.disabled=false;
  }
});
galleryCopyLink.addEventListener("click",async()=>{
  const link=new URL(galleryOpen.getAttribute("href")||"/gallery",location.origin).href;
  try{
    await navigator.clipboard.writeText(link);
    galleryCopyLink.textContent="Ссылка скопирована";
    setTimeout(()=>{galleryCopyLink.textContent="Скопировать ссылку"},1800);
  }catch{
    window.prompt("Скопируйте ссылку на галерею",link);
  }
});
deleteAll.addEventListener("click",async()=>{
  if(!mediaCount)return;
  const first=confirm(`Удалить все кадры (${mediaCount}) без возможности восстановления на сайте?\n\nСначала убедитесь, что ZIP-архив уже скачан.`);
  if(!first)return;
  const confirmation=prompt("Для окончательного подтверждения введите: УДАЛИТЬ ВСЕ");
  if(confirmation!=="УДАЛИТЬ ВСЕ"){
    adminStatus.textContent="Удаление отменено: фраза подтверждения не совпала.";
    return;
  }
  deleteAll.disabled=true;
  adminStatus.textContent="Удаляем все кадры… Не закрывайте страницу.";
  try{
    const response=await fetch("/api/admin/media",{method:"DELETE",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({confirmation,expectedCount:mediaCount})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||"Не удалось удалить все кадры");
    adminStatus.textContent=`Удалено файлов: ${data.deleted}. Коллекция очищена.`;
    await load();
  }catch(error){
    adminStatus.textContent=error.message||"Не удалось удалить все кадры. Обновите страницу и попробуйте снова.";
    deleteAll.disabled=mediaCount===0;
  }
});
form.addEventListener("submit",async event=>{
  event.preventDefault();
  error.textContent="";
  try{
    const response=await fetch("/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if(response.ok)load();else error.textContent=(await response.json()).error;
  }catch{error.textContent="Нет связи с сервером. Попробуйте ещё раз."}
});
document.querySelector("#logout").onclick=async()=>{await fetch("/api/admin/logout",{method:"POST"});location.reload()};
order.onchange=load;
load();
