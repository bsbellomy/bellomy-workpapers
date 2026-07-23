import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, FolderOpen, FolderClosed, FileText, Check, X,
  ChevronRight, ChevronDown, FileSignature, ZoomIn, ZoomOut, Maximize2,
  MessageSquare, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen,
  Clock, Layers, Settings, ScanLine, ArrowLeft, Merge, Printer,
  RefreshCw, Trash2, Calculator, FileSpreadsheet, StickyNote, Copy, CreditCard, RotateCw, Mail, Inbox,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tickmark  { id:string; page:number; x:number; y:number; type:string; note:string; author:string; createdAt:string }
interface Signoff   { page:number; role:string; author:string; signedAt:string }
interface TapeStamp { id:string; page:number; x:number; y:number; entries:{value:number}[]; author:string; createdAt:string }
interface Highlight { id:string; page:number; x:number; y:number; w:number; h:number; author:string; createdAt:string }
interface Annotations { tickmarks:Tickmark[]; signoffs:Signoff[]; tapeStamps?:TapeStamp[]; highlights?:Highlight[]; addedAt?:string; addedBy?:string|null }
interface DocFile  { name:string; type:'file';   path:string; annotations:Annotations }
interface DocFolder{ name:string; type:'folder'; path:string; children:(DocFile|DocFolder)[] }
interface Bookmark { title:string; page:number|null; items:Bookmark[] }

function fileExt(name:string):string { return (name.match(/\.([^.]+)$/)?.[1]??'').toLowerCase() }
function isPdfFile(name:string):boolean { return fileExt(name)==='pdf' }
function isWordFile(name:string):boolean { return fileExt(name)==='doc'||fileExt(name)==='docx' }
function isExcelFile(name:string):boolean { return fileExt(name)==='xls'||fileExt(name)==='xlsx' }
function isImageFile(name:string):boolean { const e=fileExt(name); return ['jpg','jpeg','png','gif','bmp','webp'].includes(e) }
function needsExternalApp(name:string):boolean { return !isPdfFile(name)&&!isImageFile(name)&&fileExt(name)!=='txt' }
function initials(name:string):string {
  const parts=name.trim().split(/\s+/).filter(Boolean)
  if(parts.length===0) return ''
  if(parts.length===1) return parts[0].slice(0,2).toUpperCase()
  return (parts[0][0]+parts[parts.length-1][0]).toUpperCase()
}

// Not a secret — just the default Worker endpoint, pre-filled in Settings. The upload secret
// itself can't be hardcoded here since this repo is public.
const DEFAULT_WORKER_URL='https://share.bellomycpa.com'

const api = (window as unknown as { electronAPI?: {
  listClients:    (p:string)=>Promise<string[]>
  listDocs:       (p:string)=>Promise<(DocFile|DocFolder)[]>
  readPdf:        (p:string)=>Promise<ArrayBuffer|null>
  getAnnotations: (p:string)=>Promise<Annotations>
  saveAnnotations:(p:string,a:Annotations)=>Promise<boolean>
  moveFile:       (src:string,dest:string)=>Promise<{ok:boolean;error?:string}>
  renameFile:     (p:string,n:string)=>Promise<{ok:boolean;error?:string;newPath?:string}>
  combineFiles:   (top:string,bot:string)=>Promise<{ok:boolean;error?:string}>
  pickScanner:    ()=>Promise<string|null>
  getScanInbox:   ()=>Promise<string>
  startScan:       (destFolder:string,useNativeUI:boolean,dpi?:number,colorMode?:string,scanName?:string,skipBlank?:boolean,appendToPath?:string)=>Promise<{ok:boolean;error?:string}>
  listFolder:      (p:string)=>Promise<(DocFile|DocFolder)[]>
  listScanDevices: ()=>Promise<{ok:boolean;devices:{ID:string;Name:string;driver?:string}[];error?:string}>
  stopScanWatcher: ()=>Promise<void>
  onScanFile:      (cb:(data:{name:string;destFolder:string;appended?:boolean})=>void)=>void
  onScanError:     (cb:(err:string)=>void)=>void
  onScanProgress:  (cb:(data:{page:number})=>void)=>void
  pickFolder:     ()=>Promise<string|null>
  deleteFile:     (p:string)=>Promise<{ok:boolean;error?:string}>
  copyFile:       (p:string)=>Promise<{ok:boolean;error?:string;destPath?:string}>
  savePdf:        (p:string,b:ArrayBuffer)=>Promise<{ok:boolean;error?:string}>
  renameFolder:   (p:string,n:string)=>Promise<{ok:boolean;error?:string;newPath?:string}>
  hoistFolder:    (p:string)=>Promise<{ok:boolean;error?:string;path?:string}>
  unhoistFolder:  (p:string,originalFolder:string)=>Promise<{ok:boolean;error?:string}>
  openFile:       (p:string)=>Promise<{ok:boolean;error?:string}>
  createFolder:   (parentPath:string,name:string)=>Promise<{ok:boolean;error?:string;path?:string}>
  testWriteAccess:(folderPath:string)=>Promise<{ok:boolean;error?:string}>
  createNotesFile:(p:string)=>Promise<{ok:boolean;error?:string;path?:string;openError?:string}>
  readTextFile:   (p:string)=>Promise<{ok:boolean;error?:string;content?:string}>
  writeTextFile:  (p:string,content:string)=>Promise<{ok:boolean;error?:string}>
  findTaxForm:    (clientPath:string)=>Promise<{ok:boolean;error?:string;result?:{path:string;name:string;year:string|null}|null}>
  findTaxForms:   (clientPath:string)=>Promise<{ok:boolean;error?:string;results?:{path:string;name:string;year:string|null}[]}>
  getConfig:      (k:string)=>Promise<unknown>
  setConfig:      (k:string,v:unknown)=>Promise<boolean>
  setSecret:      (k:string,v:string)=>Promise<boolean>
  getMagicLinkConfig: ()=>Promise<{workerUrl:string;hasUploadSecret:boolean}>
  sendMagicLinks: (items:{name:string;path?:string;bytes?:ArrayBuffer;pages?:string}[],expiresDays:number)=>Promise<{ok:boolean;error?:string;results?:{name:string;url?:string;error?:string}[]}>
  openExternal:   (url:string)=>Promise<boolean>
  createUploadRequest:(label:string,instructions:string,expiresDays:number,folderPath:string)=>Promise<{ok:boolean;token?:string;url?:string;error?:string}>
  listUploadRequests:()=>Promise<Record<string,{label:string;folderPath:string;url:string;createdAt:string;expiresDays:number}>>
  checkUploads:(token:string)=>Promise<{ok:boolean;files?:string[];label?:string;expiresAt?:number;error?:string}>
  downloadAndSaveUpload:(token:string,filename:string)=>Promise<{ok:boolean;path?:string;error?:string}>
  revokeUploadRequest:(token:string)=>Promise<{ok:boolean;error?:string}>
  printFile:      (p:string)=>Promise<{ok:boolean;error?:string}>
  printBytes:     (b:ArrayBuffer)=>Promise<{ok:boolean;error?:string}>
  getVersion:      ()=>Promise<string>
  checkForUpdates: ()=>Promise<{status:string;message:string;version?:string}>
  onUpdateDownloaded: (cb:()=>void)=>void
  minimizeWindow: ()=>void
  maximizeWindow: ()=>void
  closeWindow:    ()=>void
}}).electronAPI

// ── Colors ────────────────────────────────────────────────────────────────────

const C = {
  paper:'#F4EFE6', paperDeep:'#EBE4D5', paperLight:'#FBF8F1',
  ink:'#1A1612', inkSoft:'#3D3530', inkMuted:'#7A6E62', inkFaint:'#A89F92',
  rule:'#D9D0BE', ruleSoft:'#E8E0CE',
  ochre:'#A8771F', ochreDeep:'#7A5615', ochreLight:'#F2DFA8', ochreSoft:'#FAF1D8',
}

// 4 colored checkmarks shown on the right rail
const CHECKS = [
  { id:'check', color:'#5C8A3A', label:'OK'    },
  { id:'note',  color:'#2C6B7A', label:'Note'  },
  { id:'q',     color:'#B8870A', label:'Query' },
  { id:'x',     color:'#B5443A', label:'Issue' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function flatFiles(tree:(DocFile|DocFolder)[]): DocFile[] {
  const out:DocFile[]=[]
  for(const n of tree){if(n.type==='file')out.push(n);else out.push(...flatFiles(n.children))}
  return out
}

function visibleFiles(nodes:(DocFile|DocFolder)[], expanded:Set<string>): DocFile[] {
  const out:DocFile[]=[]
  for(const n of nodes){
    if(n.type==='file') out.push(n)
    else if(expanded.has(n.path)) out.push(...visibleFiles(n.children,expanded))
  }
  return out
}

function flatFolders(tree:(DocFile|DocFolder)[], out:DocFolder[]=[]):DocFolder[] {
  for(const n of tree){if(n.type==='folder'){out.push(n);flatFolders(n.children,out)}}
  return out
}

// ── Edit File Modal ───────────────────────────────────────────────────────────

interface BmBtn { id:string; label:string }

function EditFileModal({file,onClose,onSaved,bookmarkButtons,onBookmarkButtonsChange}:{file:DocFile;onClose:()=>void;onSaved:()=>void;bookmarkButtons:BmBtn[];onBookmarkButtonsChange:(btns:BmBtn[])=>void}){
  const [thumbs,setThumbs]           = useState<string[]>([])
  const [pageCount,setPageCount]     = useState(0)
  const [loading,setLoading]         = useState(true)
  const [loadPct,setLoadPct]         = useState(0)
  const [selPage,setSelPage]         = useState(0)
  const [assignments,setAssignments] = useState<Record<number,string>>({})
  const [customTitles,setCustomTitles] = useState<Record<number,string>>({})
  const buttons = bookmarkButtons
  const [newLabel,setNewLabel]       = useState('')
  const [saving,setSaving]           = useState(false)
  const [progress,setProgress]       = useState(0)
  const [loadError,setLoadError]     = useState<string|null>(null)
  const [thumbZoom,setThumbZoom]     = useState(160)
  const pageListRef                  = useRef<HTMLDivElement|null>(null)
  const pageItemRefs                 = useRef<(HTMLDivElement|null)[]>([])

  // Load thumbnail zoom from persistent config file on first open
  useEffect(()=>{
    api?.getConfig('editorThumbZoom').then(v=>{ if(typeof v==='number'&&v>0) setThumbZoom(v) })
  },[])

  // + key advances to next page without assigning
  useEffect(()=>{
    function onKey(e:KeyboardEvent){
      if(e.key!=='+') return
      const t=e.target as HTMLElement
      if(t.tagName==='INPUT'||t.tagName==='TEXTAREA') return
      e.preventDefault()
      setSelPage(p=>Math.min(p+1,pageCount-1))
    }
    window.addEventListener('keydown',onKey)
    return()=>window.removeEventListener('keydown',onKey)
  },[pageCount])

  function changeThumbZoom(v:number){
    const clamped=Math.max(80,Math.min(900,v))
    setThumbZoom(clamped)
    api?.setConfig('editorThumbZoom',clamped)
  }

  // Scroll newly selected page into view at the top of the list
  useEffect(()=>{
    const el=pageItemRefs.current[selPage]
    if(el) el.scrollIntoView({block:'start',behavior:'smooth'})
  },[selPage])

  useEffect(()=>{
    let cancelled=false
    async function load(){
      setLoading(true); setLoadError(null)
      try{
        if(!api) throw new Error('No API available')
        const bytes=await api.readPdf(file.path)
        if(!bytes) throw new Error('Could not read PDF — file may be missing or unreadable')
        if(cancelled) return
        const pdfjsLib=await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString()
        const pdf=await pdfjsLib.getDocument({data:new Uint8Array(bytes),disableWorker:false}).promise
        if(cancelled) return
        setPageCount(pdf.numPages)

        // Pre-populate assignments from existing PDF outline
        try{
          const outline=await pdf.getOutline()
          if(outline&&outline.length>0){
            // We need buttons loaded first; use a small delay to let them resolve
            const storedBtns=await api.getConfig('bookmarkButtons')
            const btns:BmBtn[]=Array.isArray(storedBtns)?(storedBtns as BmBtn[]):[]
            const initAssign:Record<number,string>={}
            for(const item of outline){
              const btn=btns.find(b=>b.label===item.title)
              if(btn&&item.dest){
                try{
                  let dest:any=item.dest
                  if(typeof dest==='string') dest=await pdf.getDestination(dest)
                  if(dest?.[0]){
                    const pgIdx=await pdf.getPageIndex(dest[0])
                    initAssign[pgIdx]=btn.id
                  }
                }catch{}
              }
            }
            if(!cancelled) setAssignments(initAssign)
          }
        }catch{}

        const t:string[]=[]
        for(let i=1;i<=pdf.numPages;i++){
          if(cancelled) return
          try{
            const pg=await pdf.getPage(i)
            const vp=pg.getViewport({scale:1.5})
            const cv=document.createElement('canvas')
            cv.width=Math.round(vp.width); cv.height=Math.round(vp.height)
            const ctx=cv.getContext('2d')
            if(ctx) await pg.render({canvasContext:ctx,viewport:vp}).promise.catch(()=>{})
            t.push(cv.toDataURL('image/jpeg',0.85))
          }catch{ t.push('') }
          setLoadPct(Math.round(i/pdf.numPages*100))
        }
        if(!cancelled){setThumbs(t);setLoading(false)}
      }catch(e){
        if(!cancelled){setLoadError(String(e));setLoading(false)}
      }
    }
    load()
    return()=>{cancelled=true}
  },[file.path])

  function saveButtons(btns:BmBtn[]){
    onBookmarkButtonsChange(btns)
    api?.setConfig('bookmarkButtons',btns)
  }

  function addButton(){
    if(!newLabel.trim()) return
    saveButtons([...buttons,{id:crypto.randomUUID(),label:newLabel.trim()}])
    setNewLabel('')
  }

  function moveBtn(i:number,dir:-1|1){
    const j=i+dir
    if(j<0||j>=buttons.length) return
    const n=[...buttons];[n[i],n[j]]=[n[j],n[i]];saveButtons(n)
  }

  async function handleSave(){
    if(!api) return
    setSaving(true); setProgress(5)
    try{
      const {PDFDocument,PDFHexString,PDFName,PDFNumber,PDFDict,PDFArray}=await import('pdf-lib')
      setProgress(10)
      const bytes=await api.readPdf(file.path)
      if(!bytes) throw new Error('Could not read file')
      setProgress(20)

      // ── Pass 1: copy pages in original order to clean bytes ─────────────────
      const srcDoc=await PDFDocument.load(bytes)
      const n=srcDoc.getPageCount()
      setProgress(35)
      const doc1=await PDFDocument.create()
      const copiedPages=await doc1.copyPages(srcDoc,Array.from({length:n},(_,i)=>i))
      copiedPages.forEach(p=>doc1.addPage(p))
      setProgress(55)
      const cleanBytes=await doc1.save({useObjectStreams:false})
      setProgress(65)

      // ── Pass 2: build outline and save final ─────────────────────────────────
      // Every assigned page → top-level bookmark.
      // Every unassigned page → child of the most recent top-level.
      // Pages before the first assignment are left untagged.
      interface TopEntry { title:string; pageIdx:number; children:{pageIdx:number}[] }
      const topEntries:TopEntry[]=[]
      for(let pg=0;pg<n;pg++){
        if(assignments[pg]){
          const label=customTitles[pg]||buttons.find(b=>b.id===assignments[pg])?.label||'Bookmark'
          topEntries.push({title:label,pageIdx:pg,children:[]})
        } else if(topEntries.length>0){
          topEntries[topEntries.length-1].children.push({pageIdx:pg})
        }
      }

      let finalBytes=cleanBytes
      if(topEntries.length>0){
        try{
          const doc2=await PDFDocument.load(cleanBytes)
          const ctx=doc2.context
          const pages2=doc2.getPages()

          function makeDest(pageIdx:number){
            const d=PDFArray.withContext(ctx)
            d.push(pages2[pageIdx].ref)
            d.push(PDFName.of('Fit'))
            return d
          }

          const parentRefs=topEntries.map(e=>{
            const d=PDFDict.withContext(ctx)
            d.set(PDFName.of('Title'),PDFHexString.fromText(e.title))
            d.set(PDFName.of('Dest'),makeDest(e.pageIdx))
            return ctx.register(d)
          })

          const childRefsByEntry=topEntries.map((e,ei)=>{
            if(e.children.length===0) return null
            const refs=e.children.map(ch=>{
              const d=PDFDict.withContext(ctx)
              d.set(PDFName.of('Title'),PDFHexString.fromText(`Page ${ch.pageIdx+1}`))
              d.set(PDFName.of('Dest'),makeDest(ch.pageIdx))
              return ctx.register(d)
            })
            refs.forEach((ref,i)=>{
              const d=ctx.lookup(ref) as PDFDict
              d.set(PDFName.of('Parent'),parentRefs[ei])
              if(i>0) d.set(PDFName.of('Prev'),refs[i-1])
              if(i<refs.length-1) d.set(PDFName.of('Next'),refs[i+1])
            })
            return refs
          })

          parentRefs.forEach((pRef,ei)=>{
            const pd=ctx.lookup(pRef) as PDFDict
            const ch=childRefsByEntry[ei]
            if(ch&&ch.length>0){
              pd.set(PDFName.of('First'),ch[0])
              pd.set(PDFName.of('Last'),ch[ch.length-1])
              pd.set(PDFName.of('Count'),PDFNumber.of(-ch.length))
            }
          })

          parentRefs.forEach((ref,i)=>{
            const d=ctx.lookup(ref) as PDFDict
            if(i>0) d.set(PDFName.of('Prev'),parentRefs[i-1])
            if(i<parentRefs.length-1) d.set(PDFName.of('Next'),parentRefs[i+1])
          })

          const totalVisible=topEntries.reduce((s,_e,ei)=>s+1+(childRefsByEntry[ei]?.length??0),0)
          const rootDict=PDFDict.withContext(ctx)
          rootDict.set(PDFName.of('Type'),PDFName.of('Outlines'))
          rootDict.set(PDFName.of('First'),parentRefs[0])
          rootDict.set(PDFName.of('Last'),parentRefs[parentRefs.length-1])
          rootDict.set(PDFName.of('Count'),PDFNumber.of(totalVisible))
          const rootRef=ctx.register(rootDict)
          parentRefs.forEach(ref=>(ctx.lookup(ref) as PDFDict).set(PDFName.of('Parent'),rootRef))

          doc2.catalog.set(PDFName.of('Outlines'),rootRef)
          doc2.catalog.set(PDFName.of('PageMode'),PDFName.of('UseOutlines'))
          finalBytes=await doc2.save({useObjectStreams:false})
        }catch(bmErr){
          console.warn('Bookmark embed skipped:',bmErr)
        }
      }

      setProgress(90)
      const buf=finalBytes.buffer.slice(finalBytes.byteOffset,finalBytes.byteOffset+finalBytes.byteLength)
      const result=await api.savePdf(file.path,buf)
      if(!result.ok) throw new Error(result.error)
      setProgress(100)
      setTimeout(()=>{onSaved();onClose()},600)
    }catch(e){
      alert('Save failed: '+String(e))
      setSaving(false); setProgress(0)
    }
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.6)'}}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:'90vw',height:'88vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.3)'}}>
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Edit File: {file.name}</span>
          <button onClick={onClose} style={{color:C.inkFaint}}><X size={16}/></button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Pages */}
          <div className="flex flex-col flex-1 overflow-hidden" style={{borderRight:`1px solid ${C.rule}`}}>
            <div className="px-4 py-2 flex-shrink-0 flex items-center gap-3" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
              <span className="sans" style={{fontSize:11,color:C.inkMuted,letterSpacing:0.5,textTransform:'uppercase',fontWeight:600}}>Pages</span>
              {loading&&<span className="sans" style={{fontSize:10,color:C.inkFaint}}>Loading thumbnails… {loadPct}%</span>}
              <div className="flex items-center gap-1" style={{marginLeft:'auto'}}>
                <button onClick={()=>changeThumbZoom(thumbZoom-30)} title="Smaller thumbnails" style={{color:C.inkFaint,padding:'2px 4px'}}><ZoomOut size={12}/></button>
                <button onClick={()=>changeThumbZoom(thumbZoom+30)} title="Larger thumbnails" style={{color:C.inkFaint,padding:'2px 4px'}}><ZoomIn size={12}/></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3" style={{display:'flex',flexWrap:'wrap',alignContent:'flex-start',gap:8}}>
              {loadError?(
                <div style={{gridColumn:'1/-1',padding:24,color:'#B5443A',fontSize:12,lineHeight:1.6}}>
                  <div style={{fontWeight:600,marginBottom:6}}>Failed to load PDF</div>
                  <div style={{fontFamily:'monospace',fontSize:11,backgroundColor:'#FFF5F5',padding:10,borderRadius:4,border:'1px solid #F5C6C6',wordBreak:'break-all'}}>{loadError}</div>
                </div>
              ):loading?(
                <div style={{textAlign:'center',padding:40,color:C.inkFaint,fontSize:12,width:'100%'}}>
                  <div style={{marginBottom:8}}>Rendering pages… {loadPct}%</div>
                  <div style={{height:4,backgroundColor:C.ruleSoft,borderRadius:2,overflow:'hidden'}}>
                    <div style={{height:'100%',backgroundColor:C.ochre,width:`${loadPct}%`,transition:'width 0.2s'}}/>
                  </div>
                </div>
              ):Array.from({length:pageCount},(_,i)=>(
                <div key={i} ref={el=>{pageItemRefs.current[i]=el}} onClick={()=>setSelPage(i)} className="rounded cursor-pointer"
                  style={{width:thumbZoom,border:`2px solid ${selPage===i?C.ochre:C.ruleSoft}`,backgroundColor:selPage===i?C.ochreSoft:'transparent',overflow:'hidden',flexShrink:0}}>
                  {thumbs[i]
                    ?<img src={thumbs[i]} style={{width:'100%',height:'auto',display:'block'}} alt=""/>
                    :<div style={{width:'100%',aspectRatio:'8.5/11',backgroundColor:C.paperDeep}}/>
                  }
                  <div style={{padding:'4px 8px',borderTop:`1px solid ${selPage===i?C.ochreLight:C.ruleSoft}`,backgroundColor:selPage===i?C.ochreSoft:C.paperLight}}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono" style={{fontSize:10,color:C.inkMuted}}>Pg {i+1}</span>
                      {assignments[i]?(
                        <div className="flex items-center gap-1">
                          <div className="flex items-center sans" style={{fontSize:10,borderRadius:3,overflow:'hidden',fontWeight:600,border:`1px solid ${customTitles[i]!==undefined?'#8aba7e':C.ochreLight}`}}>
                            <span style={{color:C.ochreDeep,backgroundColor:customTitles[i]!==undefined?'#D8E8D0':C.ochreLight,padding:'1px 5px'}}>
                              {customTitles[i]!==undefined?customTitles[i]||buttons.find(b=>b.id===assignments[i])?.label:buttons.find(b=>b.id===assignments[i])?.label}
                            </span>
                            <button
                              title="Promote to its own top-level bookmark"
                              onClick={e=>{
                                e.stopPropagation()
                                const current=customTitles[i]??buttons.find(b=>b.id===assignments[i])?.label??''
                                const next=window.prompt('Promote: enter a title for this page (clear to regroup under shared category):',current)
                                if(next===null) return
                                setCustomTitles(p=>{const n={...p};if(next.trim()==='') delete n[i];else n[i]=next.trim();return n})
                              }}
                              style={{backgroundColor:customTitles[i]!==undefined?'#8aba7e':'rgba(0,0,0,0.08)',borderLeft:`1px solid ${customTitles[i]!==undefined?'#6aa35e':'rgba(0,0,0,0.12)'}`,color:customTitles[i]!==undefined?'#fff':C.inkFaint,fontWeight:700,fontSize:9,padding:'0 4px',lineHeight:'18px'}}
                            >P</button>
                          </div>
                          <button onClick={e=>{e.stopPropagation();setAssignments(p=>{const n={...p};delete n[i];return n});setCustomTitles(p=>{const n={...p};delete n[i];return n})}} style={{color:C.inkFaint}}><X size={9}/></button>
                        </div>
                      ):(
                        <span className="sans" style={{fontSize:10,color:selPage===i?C.ochre:C.inkFaint}}>
                          {selPage===i?'← assign':'—'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* Bookmark buttons */}
          <div className="flex flex-col flex-shrink-0" style={{width:264,backgroundColor:C.paper}}>
            <div className="px-4 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
              <span className="sans" style={{fontSize:11,color:C.inkMuted,letterSpacing:0.5,textTransform:'uppercase',fontWeight:600}}>Bookmark Buttons</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(110px,1fr))',gap:4,alignContent:'start'}}>
              {buttons.length===0&&<div style={{gridColumn:'1/-1',color:C.inkFaint,fontSize:11,textAlign:'center',padding:'16px 8px'}}>No buttons yet — add one below.</div>}
              {buttons.map((btn,i)=>(
                <div key={btn.id} className="flex items-center gap-1">
                  <button
                    onClick={()=>{
                      setAssignments(p=>({...p,[selPage]:btn.id}))
                      setSelPage(p=>Math.min(p+1,pageCount-1))
                    }}
                    className="flex-1 text-left rounded px-3 py-2 sans"
                    style={{fontSize:12,backgroundColor:C.ochreSoft,color:C.ochreDeep,border:`1px solid ${C.ochreLight}`,fontWeight:600}}>
                    {btn.label}
                  </button>
                  <button onClick={()=>moveBtn(i,-1)} disabled={i===0} style={{color:C.inkFaint,fontSize:12,padding:'0 2px',opacity:i===0?0.3:1}}>↑</button>
                  <button onClick={()=>moveBtn(i,1)} disabled={i===buttons.length-1} style={{color:C.inkFaint,fontSize:12,padding:'0 2px',opacity:i===buttons.length-1?0.3:1}}>↓</button>
                  <button onClick={()=>saveButtons(buttons.filter((_,j)=>j!==i))} style={{color:'#B5443A',padding:'0 2px'}}><X size={11}/></button>
                </div>
              ))}
            </div>
            <div className="px-3 pb-1 flex-shrink-0" style={{borderTop:`1px solid ${C.ruleSoft}`,paddingTop:6}}>
              <span className="sans" style={{fontSize:10,color:C.inkFaint}}>Click = top-level bookmark &nbsp;·&nbsp; <kbd style={{fontFamily:'monospace',fontSize:10}}>+</kbd> = advance without tagging</span>
            </div>
            <div className="p-3 flex-shrink-0" style={{borderTop:`1px solid ${C.ruleSoft}`}}>
              <div className="flex gap-1 mb-2">
                <input type="text" placeholder="New button label…" value={newLabel}
                  onChange={e=>setNewLabel(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addButton()}}
                  className="flex-1 outline-none sans px-2 py-1 rounded"
                  style={{fontSize:12,backgroundColor:C.paper,border:`1px solid ${C.rule}`,color:C.ink}}/>
                <button onClick={addButton} className="px-2 py-1 rounded sans" style={{fontSize:13,backgroundColor:C.ochre,color:C.paperLight,fontWeight:700}}>+</button>
              </div>
              <div style={{fontSize:10,color:C.inkFaint,lineHeight:1.4}}>Select a page, then click a button to assign. Button order = page sort order on save.</div>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0" style={{backgroundColor:C.paperDeep,borderTop:`1px solid ${C.rule}`}}>
          {saving?(
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="sans" style={{fontSize:11,color:C.inkMuted}}>Saving…</span>
                <span className="mono" style={{fontSize:11,color:C.inkMuted}}>{progress}%</span>
              </div>
              <div style={{height:6,backgroundColor:C.ruleSoft,borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',backgroundColor:C.ochre,width:`${progress}%`,transition:'width 0.3s'}}/>
              </div>
            </div>
          ):<div className="flex-1"/>}
          <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded sans" style={{fontSize:12,color:C.inkMuted,backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>Cancel</button>
          <button onClick={handleSave} disabled={saving||loading} className="px-4 py-2 rounded sans"
            style={{fontSize:12,backgroundColor:C.ochre,color:C.paperLight,fontWeight:600,opacity:(saving||loading)?0.6:1}}>
            Save & Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit Folder Modal ─────────────────────────────────────────────────────────

function EditFolderModal({folder,docTree,onClose,onSaved}:{folder:DocFolder;docTree:(DocFile|DocFolder)[];onClose:()=>void;onSaved:()=>void}){
  type Action='combine'|'move'|'rename'
  const [action,setAction]     = useState<Action>('combine')
  const [selected,setSelected] = useState<DocFile[]>([])
  const [progress,setProgress] = useState(0)
  const [saving,setSaving]     = useState(false)
  const [outputFileIdx,setOutputFileIdx] = useState(0)
  const [destPath,setDestPath] = useState('')
  const [renames,setRenames]   = useState<Record<string,string>>({})

  const folderFiles=folder.children.filter((n):n is DocFile=>n.type==='file')
  const available=folderFiles.filter(f=>!selected.some(s=>s.path===f.path))
  const allFolders=flatFolders(docTree).filter(f=>f.path!==folder.path)

  function toggle(file:DocFile){
    if(selected.some(s=>s.path===file.path)){
      setSelected(selected.filter(s=>s.path!==file.path))
    } else {
      setSelected([...selected,file])
      if(action==='rename'&&!renames[file.path])
        setRenames(p=>({...p,[file.path]:file.name.replace(/\.[^.]+$/,'')}))
    }
  }

  function moveUp(i:number){if(i===0)return;const n=[...selected];[n[i-1],n[i]]=[n[i],n[i-1]];setSelected(n)}
  function moveDown(i:number){if(i===selected.length-1)return;const n=[...selected];[n[i],n[i+1]]=[n[i+1],n[i]];setSelected(n)}

  async function handleSave(){
    if(!api||selected.length===0) return
    setSaving(true); setProgress(5)
    try{
      if(action==='combine'){
        const {PDFDocument}=await import('pdf-lib')
        const merged=await PDFDocument.create()
        for(let i=0;i<selected.length;i++){
          setProgress(10+Math.round(i/selected.length*60))
          const bytes=await api.readPdf(selected[i].path)
          if(!bytes) continue
          const ext=fileExt(selected[i].name)
          if(ext==='jpg'||ext==='jpeg'){
            const img=await merged.embedJpg(bytes)
            const pg=merged.addPage([img.width,img.height])
            pg.drawImage(img,{x:0,y:0,width:img.width,height:img.height})
          } else if(ext==='png'){
            const img=await merged.embedPng(bytes)
            const pg=merged.addPage([img.width,img.height])
            pg.drawImage(img,{x:0,y:0,width:img.width,height:img.height})
          } else {
            try{
              const doc=await PDFDocument.load(bytes)
              const pages=await merged.copyPages(doc,doc.getPageIndices())
              pages.forEach(p=>merged.addPage(p))
            }catch{ continue }
          }
        }
        setProgress(75)
        const saved=await merged.save({useObjectStreams:false})
        const keepIdx=Math.min(outputFileIdx,selected.length-1)
        let keepPath=selected[keepIdx].path
        const keepIsImage=isImageFile(selected[keepIdx].name)
        if(keepIsImage){
          // derive a .pdf path in the same folder
          keepPath=keepPath.replace(/\.[^.]+$/,'.pdf')
        }
        const r=await api.savePdf(keepPath,saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength))
        if(!r.ok) throw new Error(r.error)
        // Delete all selected files (including the original image if keepIsImage)
        for(const f of selected){ await api.deleteFile(f.path) }
      } else if(action==='move'){
        for(let i=0;i<selected.length;i++){
          setProgress(10+Math.round(i/selected.length*85))
          const r=await api.moveFile(selected[i].path,destPath)
          if(!r.ok) throw new Error(r.error)
        }
      } else {
        for(let i=0;i<selected.length;i++){
          setProgress(10+Math.round(i/selected.length*85))
          const origExt=selected[i].name.match(/\.[^.]+$/)?.[0]??''
          const newName=(renames[selected[i].path]||selected[i].name.replace(/\.[^.]+$/,''))+origExt
          if(newName!==selected[i].name){
            const r=await api.renameFile(selected[i].path,newName)
            if(!r.ok) throw new Error(r.error)
          }
        }
      }
      setProgress(100)
      setTimeout(()=>{onSaved();onClose()},600)
    }catch(e){
      alert('Operation failed: '+String(e))
      setSaving(false); setProgress(0)
    }
  }

  const canSave=selected.length>0&&!saving&&(action!=='move'||!!destPath)

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.6)'}}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:'82vw',height:'82vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.3)'}}>
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Edit Folder: {folder.name}</span>
          <button onClick={onClose} style={{color:C.inkFaint}}><X size={16}/></button>
        </div>
        {/* Tabs */}
        <div className="flex flex-shrink-0" style={{borderBottom:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          {(['combine','move','rename'] as Action[]).map(a=>(
            <button key={a} onClick={()=>{setAction(a);setSelected([])}}
              className="px-5 py-2.5 sans"
              style={{fontSize:12,fontWeight:600,color:action===a?C.ochreDeep:C.inkMuted,borderBottom:action===a?`2px solid ${C.ochre}`:'2px solid transparent',textTransform:'capitalize'}}>
              {a==='combine'?'Combine Files':a==='move'?'Move Files':'Rename Files'}
            </button>
          ))}
        </div>
        {/* Body */}
        <div className="flex flex-1 overflow-hidden p-4 gap-4">
          {/* Available */}
          <div className="flex flex-col flex-1 overflow-hidden rounded" style={{border:`1px solid ${C.rule}`}}>
            <div className="px-3 py-2 flex-shrink-0" style={{backgroundColor:C.paperDeep,borderBottom:`1px solid ${C.ruleSoft}`}}>
              <span className="sans" style={{fontSize:10,letterSpacing:0.8,textTransform:'uppercase',color:C.inkMuted,fontWeight:600}}>Available ({available.length})</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {available.map(f=>(
                <div key={f.path} className="flex items-center gap-2 px-3 py-2 cursor-pointer row-hover" onClick={()=>toggle(f)}>
                  <FileText size={12} style={{color:C.inkFaint,flexShrink:0}}/>
                  <span className="sans flex-1 truncate" style={{fontSize:12,color:C.ink}}>{f.name}</span>
                  <span style={{color:C.ochre,fontSize:14}}>→</span>
                </div>
              ))}
              {available.length===0&&<div style={{color:C.inkFaint,fontSize:11,padding:'12px 16px'}}>All files selected</div>}
            </div>
          </div>
          {/* Selected */}
          <div className="flex flex-col flex-1 overflow-hidden rounded" style={{border:`1px solid ${C.ochreLight}`}}>
            <div className="px-3 py-2 flex-shrink-0" style={{backgroundColor:C.ochreSoft,borderBottom:`1px solid ${C.ochreLight}`}}>
              <span className="sans" style={{fontSize:10,letterSpacing:0.8,textTransform:'uppercase',color:C.ochreDeep,fontWeight:600}}>Selected ({selected.length})</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {selected.map((f,i)=>(
                <div key={f.path} className="flex items-center gap-2 px-3 py-2">
                  {action==='rename'?(
                    <>
                      <FileText size={12} style={{color:C.ochre,flexShrink:0}}/>
                      <input type="text" value={renames[f.path]??f.name.replace(/\.[^.]+$/,'')}
                        onChange={e=>setRenames(p=>({...p,[f.path]:e.target.value}))}
                        className="flex-1 outline-none sans px-1 rounded"
                        style={{fontSize:11,color:C.ink,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}/>
                      <span style={{color:C.inkFaint,fontSize:10,flexShrink:0}}>.pdf</span>
                    </>
                  ):(
                    <>
                      <span className="mono flex-shrink-0" style={{fontSize:10,color:C.inkFaint,width:16,textAlign:'right'}}>{i+1}</span>
                      <FileText size={12} style={{color:C.ochre,flexShrink:0}}/>
                      <span className="sans flex-1 truncate" style={{fontSize:12,color:C.ink}}>{f.name}</span>
                    </>
                  )}
                  <div className="flex gap-0.5 flex-shrink-0">
                    <button onClick={()=>moveUp(i)} disabled={i===0} style={{color:C.inkFaint,fontSize:12,padding:'0 2px',opacity:i===0?0.3:1}}>↑</button>
                    <button onClick={()=>moveDown(i)} disabled={i===selected.length-1} style={{color:C.inkFaint,fontSize:12,padding:'0 2px',opacity:i===selected.length-1?0.3:1}}>↓</button>
                    <button onClick={()=>toggle(f)} style={{color:'#B5443A',padding:'0 2px'}}><X size={11}/></button>
                  </div>
                </div>
              ))}
              {selected.length===0&&<div style={{color:C.inkFaint,fontSize:11,padding:'12px 16px'}}>Click files on the left to add them</div>}
            </div>
          </div>
          {/* Options */}
          <div className="flex flex-col flex-shrink-0 gap-3" style={{width:210}}>
            {action==='combine'&&(
              <div className="p-3 rounded" style={{border:`1px solid ${C.rule}`,backgroundColor:C.paper}}>
                <div className="sans mb-1" style={{fontSize:11,color:C.inkMuted,fontWeight:600}}>Keep as:</div>
                <select value={outputFileIdx} onChange={e=>setOutputFileIdx(Number(e.target.value))}
                  className="w-full outline-none sans px-2 py-1 rounded"
                  style={{fontSize:11,color:C.ink,border:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
                  {selected.map((f,i)=><option key={f.path} value={i}>{f.name}</option>)}
                  {selected.length===0&&<option value={0}>Select files first</option>}
                </select>
                <div style={{fontSize:10,color:C.inkFaint,marginTop:4}}>Other selected files will be deleted after combining.</div>
              </div>
            )}
            {action==='move'&&(
              <div className="p-3 rounded" style={{border:`1px solid ${C.rule}`,backgroundColor:C.paper}}>
                <div className="sans mb-1" style={{fontSize:11,color:C.inkMuted,fontWeight:600}}>Destination Folder</div>
                <select value={destPath} onChange={e=>setDestPath(e.target.value)}
                  className="w-full outline-none sans px-2 py-1 rounded"
                  style={{fontSize:11,color:C.ink,border:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
                  <option value="">Select a folder…</option>
                  {allFolders.map(f=><option key={f.path} value={f.path}>{f.name}</option>)}
                </select>
              </div>
            )}
            {action==='rename'&&(
              <div className="p-3 rounded" style={{border:`1px solid ${C.rule}`,backgroundColor:C.paper}}>
                <div style={{fontSize:11,color:C.inkMuted,lineHeight:1.5}}>Edit the name for each selected file. The <strong>.pdf</strong> extension is added automatically.</div>
              </div>
            )}
          </div>
        </div>
        {/* Footer */}
        <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0" style={{backgroundColor:C.paperDeep,borderTop:`1px solid ${C.rule}`}}>
          {saving?(
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="sans" style={{fontSize:11,color:C.inkMuted}}>Working…</span>
                <span className="mono" style={{fontSize:11,color:C.inkMuted}}>{progress}%</span>
              </div>
              <div style={{height:6,backgroundColor:C.ruleSoft,borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',backgroundColor:C.ochre,width:`${progress}%`,transition:'width 0.3s'}}/>
              </div>
            </div>
          ):<div className="flex-1"/>}
          <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded sans" style={{fontSize:12,color:C.inkMuted,backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave} className="px-4 py-2 rounded sans"
            style={{fontSize:12,backgroundColor:C.ochre,color:C.paperLight,fontWeight:600,opacity:canSave?1:0.5}}>
            Save & Close
          </button>
        </div>
      </div>
    </div>
  )
}

// Returns today's date formatted as MM-DD-YYYY
function todayStr(){
  const d=new Date()
  const mm=String(d.getMonth()+1).padStart(2,'0')
  const dd=String(d.getDate()).padStart(2,'0')
  const yyyy=d.getFullYear()
  return `${mm}-${dd}-${yyyy}`
}

// Generates a CSS clip-path polygon with a torn-paper zigzag along the top and bottom edges
function tornClipPath(teeth=9, depth=5){
  const pts:string[]=[]
  for(let i=0;i<=teeth;i++){
    const x=(i/teeth)*100
    const y=i%2===0?0:depth
    pts.push(`${x}% ${y}%`)
  }
  for(let i=teeth;i>=0;i--){
    const x=(i/teeth)*100
    const y=i%2===0?100:100-depth
    pts.push(`${x}% ${y}%`)
  }
  return `polygon(${pts.join(',')})`
}

// ── PDF Viewer ────────────────────────────────────────────────────────────────

interface PdfViewerProps {
  pdfBytes:ArrayBuffer|null; zoom:number; page:number; onPageCount:(n:number)=>void
  onPageSize?:(w:number,h:number)=>void
  annotations:Annotations; activeMark:string
  onAddTickmark:(t:Omit<Tickmark,'id'|'author'|'createdAt'>)=>void
  onMoveTickmark:(id:string,x:number,y:number)=>void
  onAddTapeStamp:(s:Omit<TapeStamp,'id'|'author'|'createdAt'>)=>void
  onDeleteTapeStamp:(id:string)=>void
  onMoveTapeStamp:(id:string,x:number,y:number)=>void
  onAddHighlight:(h:Omit<Highlight,'id'|'author'|'createdAt'>)=>void
  onDeleteHighlight:(id:string)=>void
  author:string
}

function PdfViewer({pdfBytes,zoom,page,onPageCount,onPageSize,annotations,activeMark,onAddTickmark,onMoveTickmark,onAddTapeStamp,onDeleteTapeStamp,onMoveTapeStamp,onAddHighlight,onDeleteHighlight,author}:PdfViewerProps){
  const [dragStamp,setDragStamp]=useState<{id:string;x:number;y:number}|null>(null)
  const [dragTick,setDragTick]=useState<{id:string;x:number;y:number}|null>(null)
  const [highlightMode,setHighlightMode]=useState(false)
  const [drawRect,setDrawRect]=useState<{x:number;y:number;w:number;h:number}|null>(null)
  const [ctxMenu,setCtxMenu]=useState<{x:number;y:number}|null>(null)
  const [rulerMode,setRulerMode]=useState(false)
  const [rulerY,setRulerY]=useState<number|null>(null)
  const canvasRef=useRef<HTMLCanvasElement>(null)
  const renderTask=useRef<{cancel:()=>void;promise:Promise<any>}|null>(null)
  const renderSeq=useRef(0) // increments on every render attempt; lets async callbacks detect staleness
  const [pdfDoc,setPdfDoc]=useState<any>(null)

  // Load PDF document once when bytes change (switching files)
  useEffect(()=>{
    if(!pdfBytes){setPdfDoc(null);return}
    let cancelled=false
    async function loadDoc(){
      const pdfjsLib=await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString()
      const pdf=await pdfjsLib.getDocument({data:new Uint8Array(pdfBytes!)}).promise
      if(cancelled) return
      onPageCount(pdf.numPages)
      setPdfDoc(pdf)
    }
    setPdfDoc(null)
    loadDoc()
    return()=>{cancelled=true}
  },[pdfBytes])

  // Render a single page when doc, page, or zoom changes — no document reload
  useEffect(()=>{
    if(!pdfDoc) return
    const seq=++renderSeq.current
    async function renderPage(){
      try{
        const pdfPage=await pdfDoc.getPage(Math.min(page,pdfDoc.numPages))
        if(renderSeq.current!==seq) return // a newer render was requested; discard
        const baseVp=pdfPage.getViewport({scale:1})
        onPageSize?.(baseVp.width,baseVp.height)
        const scale=zoom/100
        const viewport=pdfPage.getViewport({scale})
        const canvas=canvasRef.current; if(!canvas) return
        canvas.width=viewport.width; canvas.height=viewport.height
        const task=pdfPage.render({canvasContext:canvas.getContext('2d')!,viewport})
        renderTask.current=task
        await task.promise.catch(()=>{})
      }catch{}
    }
    renderPage()
  },[pdfDoc,page,zoom])

  function coordsFromEvent(e:{clientX:number;clientY:number}){
    const canvas=canvasRef.current; if(!canvas) return null
    const rect=canvas.getBoundingClientRect()
    return {x:((e.clientX-rect.left)/rect.width)*100, y:((e.clientY-rect.top)/rect.height)*100}
  }

  function startDragStamp(e:React.MouseEvent,stamp:TapeStamp){
    e.stopPropagation()
    e.preventDefault()
    const canvas=canvasRef.current; if(!canvas) return
    const rect=canvas.getBoundingClientRect()
    const clamp=(v:number)=>Math.max(0,Math.min(100,v))
    function posFrom(ev:MouseEvent){
      return {x:clamp(((ev.clientX-rect.left)/rect.width)*100), y:clamp(((ev.clientY-rect.top)/rect.height)*100)}
    }
    function onMove(ev:MouseEvent){ setDragStamp({id:stamp.id,...posFrom(ev)}) }
    function onUp(ev:MouseEvent){
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
      const p=posFrom(ev)
      onMoveTapeStamp(stamp.id,p.x,p.y)
      setDragStamp(null)
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  }

  function startDragTick(e:React.MouseEvent,tm:Tickmark){
    e.stopPropagation()
    e.preventDefault()
    const canvas=canvasRef.current; if(!canvas) return
    const rect=canvas.getBoundingClientRect()
    const clamp=(v:number)=>Math.max(0,Math.min(100,v))
    function posFrom(ev:MouseEvent){
      return {x:clamp(((ev.clientX-rect.left)/rect.width)*100), y:clamp(((ev.clientY-rect.top)/rect.height)*100)}
    }
    function onMove(ev:MouseEvent){ setDragTick({id:tm.id,...posFrom(ev)}) }
    function onUp(ev:MouseEvent){
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
      const p=posFrom(ev)
      onMoveTickmark(tm.id,p.x,p.y)
      setDragTick(null)
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  }

  function handleClick(e:React.MouseEvent<HTMLDivElement>){
    setCtxMenu(null)
    if(rulerMode){ const c=coordsFromEvent(e); if(c) setRulerY(c.y); return }
    if(!activeMark||highlightMode) return
    const c=coordsFromEvent(e); if(!c) return
    onAddTickmark({page,x:c.x,y:c.y,type:activeMark,note:author})
  }

  function startDrawHighlight(e:React.MouseEvent<HTMLDivElement>){
    setCtxMenu(null)
    if(!highlightMode) return
    e.preventDefault()
    e.stopPropagation()
    const canvas=canvasRef.current; if(!canvas) return
    const rect=canvas.getBoundingClientRect()
    const clamp=(v:number)=>Math.max(0,Math.min(100,v))
    const posFrom=(ev:{clientX:number;clientY:number})=>({x:clamp(((ev.clientX-rect.left)/rect.width)*100), y:clamp(((ev.clientY-rect.top)/rect.height)*100)})
    const start=posFrom(e)
    setDrawRect({x:start.x,y:start.y,w:0,h:0})
    function onMove(ev:MouseEvent){
      const p=posFrom(ev)
      setDrawRect({x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)})
    }
    function onUp(ev:MouseEvent){
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
      const p=posFrom(ev)
      const finalRect={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)}
      if(finalRect.w>0.5&&finalRect.h>0.5) onAddHighlight({page,...finalRect})
      setDrawRect(null)
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  }

  function startDragRuler(e:React.MouseEvent){
    e.stopPropagation()
    e.preventDefault()
    const canvas=canvasRef.current; if(!canvas) return
    const rect=canvas.getBoundingClientRect()
    const clamp=(v:number)=>Math.max(0,Math.min(100,v))
    function onMove(ev:MouseEvent){ setRulerY(clamp(((ev.clientY-rect.top)/rect.height)*100)) }
    function onUp(ev:MouseEvent){
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
      setRulerY(clamp(((ev.clientY-rect.top)/rect.height)*100))
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  }

  function handleContextMenu(e:React.MouseEvent<HTMLDivElement>){
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({x:e.clientX,y:e.clientY})
  }

  function handleDrop(e:React.DragEvent<HTMLDivElement>){
    e.preventDefault()
    const type=e.dataTransfer.getData('type')
    const c=coordsFromEvent(e); if(!c) return
    if(type==='tape-stamp'){
      const entries=JSON.parse(e.dataTransfer.getData('entries')) as {value:number}[]
      onAddTapeStamp({page,x:c.x,y:c.y,entries})
    } else if(type==='tape-total'){
      // legacy fallback: drop just the total as a note
      const amount=e.dataTransfer.getData('amount')
      onAddTickmark({page,x:c.x,y:c.y,type:'note',note:amount})
    }
  }

  const pageAnns=annotations.tickmarks.filter(t=>t.page===page)
  const pageStamps=(annotations.tapeStamps??[]).filter(s=>s.page===page)
  const pageHighlights=(annotations.highlights??[]).filter(h=>h.page===page)
  const checkDefs:{[k:string]:{color:string}}=Object.fromEntries(CHECKS.map(c=>[c.id,{color:c.color}]))

  return(
    <div className="relative inline-block" style={{cursor:highlightMode||rulerMode?'crosshair':activeMark?'crosshair':'default'}}
      onClick={handleClick}
      onMouseDown={startDrawHighlight}
      onContextMenu={handleContextMenu}
      onDragOver={e=>e.preventDefault()}
      onDrop={handleDrop}
    >
      {pdfBytes
        ?<canvas ref={canvasRef} style={{display:'block'}}/>
        :<div style={{width:540,minHeight:700,backgroundColor:'#FEFCF7',display:'flex',alignItems:'center',justifyContent:'center',color:C.inkFaint,fontFamily:'Georgia,serif',fontSize:13}}>No document selected</div>
      }
      {pageHighlights.map(hl=>(
        <div key={hl.id} className="absolute group" style={{left:`${hl.x}%`,top:`${hl.y}%`,width:`${hl.w}%`,height:`${hl.h}%`,backgroundColor:'rgba(255,255,0,0.5)',mixBlendMode:'multiply',zIndex:5,cursor:'pointer'}}
          title="Click to remove highlight"
          onClick={e=>{e.stopPropagation();onDeleteHighlight(hl.id)}}
          onMouseDown={e=>e.stopPropagation()}
        />
      ))}
      {drawRect&&(
        <div className="absolute" style={{left:`${drawRect.x}%`,top:`${drawRect.y}%`,width:`${drawRect.w}%`,height:`${drawRect.h}%`,backgroundColor:'rgba(255,255,0,0.5)',mixBlendMode:'multiply',border:'1px dashed #C9A227',zIndex:6,pointerEvents:'none'}}/>
      )}
      {rulerY!==null&&(
        <div
          onMouseDown={startDragRuler}
          onClick={e=>e.stopPropagation()}
          title="Drag to move ruler · Right-click to dismiss"
          onContextMenu={e=>{e.preventDefault();e.stopPropagation();setRulerMode(false);setRulerY(null)}}
          style={{
            position:'absolute',left:0,right:0,
            top:`${rulerY}%`,height:28,
            transform:'translateY(-50%)',
            zIndex:15,cursor:'ns-resize',pointerEvents:'auto',userSelect:'none',
            backgroundImage:[
              'repeating-linear-gradient(90deg,rgba(110,65,0,0.6) 0,rgba(110,65,0,0.6) 1.5px,transparent 1.5px,transparent 50px)',
              'repeating-linear-gradient(90deg,rgba(110,65,0,0.25) 0,rgba(110,65,0,0.25) 1px,transparent 1px,transparent 10px)',
              'linear-gradient(to bottom,rgba(255,240,60,0.95) 0%,rgba(248,218,22,0.95) 45%,rgba(228,192,10,0.95) 100%)',
            ].join(','),
            borderTop:'1.5px solid rgba(155,105,0,0.7)',
            borderBottom:'1.5px solid rgba(155,105,0,0.7)',
            boxShadow:'0 3px 12px rgba(0,0,0,0.22),inset 0 1px 0 rgba(255,255,200,0.5)',
          }}
        />
      )}
      {ctxMenu&&(
        <div className="fixed z-50 rounded overflow-hidden" style={{left:ctxMenu.x,top:ctxMenu.y,backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`,boxShadow:'0 4px 16px rgba(26,22,18,0.15)',minWidth:180}}
          onClick={e=>e.stopPropagation()}
          onMouseDown={e=>e.stopPropagation()}
          onMouseLeave={()=>setCtxMenu(null)}
        >
          <button className="w-full text-left px-3 py-2 sans" style={{fontSize:12,color:C.ink,backgroundColor:highlightMode?C.ochre+'22':'transparent'}}
            onClick={()=>{setHighlightMode(m=>{const next=!m;if(next)setRulerMode(false);return next});setCtxMenu(null)}}
          >
            {highlightMode?'✓ Highlighter (click to disable)':'Highlighter tool'}
          </button>
          <button className="w-full text-left px-3 py-2 sans" style={{fontSize:12,color:C.ink,backgroundColor:rulerMode?C.ochre+'22':'transparent'}}
            onClick={()=>{setRulerMode(m=>{const next=!m;if(!next)setRulerY(null);if(next)setHighlightMode(false);return next});setCtxMenu(null)}}
          >
            {rulerMode?'✓ Ruler (click to disable)':'Ruler tool'}
          </button>
        </div>
      )}
      {pageAnns.map(tm=>{
        const def=checkDefs[tm.type]??{color:C.ochre}
        const pos=dragTick&&dragTick.id===tm.id?dragTick:tm
        return(
          <div key={tm.id} className="absolute" style={{left:`${pos.x}%`,top:`${pos.y}%`,transform:'translate(-50%,-50%)',zIndex:10,cursor:'move',pointerEvents:'auto'}}
            title={`${tm.author} · ${new Date(tm.createdAt).toLocaleDateString()}`}
            onMouseDown={e=>startDragTick(e,tm)}
            onClick={e=>e.stopPropagation()}
          >
            <div style={{backgroundColor:def.color,color:'white',fontSize:11,fontWeight:700,width:18,height:18,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:`0 2px 4px rgba(26,22,18,0.15),0 0 0 1.5px ${def.color},0 0 0 2.5px ${C.paperLight}`}}>
              ✓
            </div>
          </div>
        )
      })}
      {pageStamps.map(stamp=>{
        const total=stamp.entries.reduce((s,e)=>s+e.value,0)
        const fmt=(v:number)=>v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
        const pos=dragStamp&&dragStamp.id===stamp.id?dragStamp:stamp
        return(
          <div key={stamp.id} className="absolute" style={{left:`${pos.x}%`,top:`${pos.y}%`,transform:'translate(-10%,-6%)',zIndex:20,pointerEvents:'auto',cursor:'move'}}
            onClick={e=>e.stopPropagation()}
            onMouseDown={e=>startDragStamp(e,stamp)}
          >
            {/* paper clip — half visible, clipped onto the top edge of the tape */}
            <svg width="28" height="34" viewBox="0 0 28 34" style={{position:'absolute',top:-16,left:18,zIndex:1,filter:'drop-shadow(0 2px 2px rgba(0,0,0,0.25))',pointerEvents:'none'}}>
              <path d="M8 34 V10 a6 6 0 0 1 12 0 V26 a3 3 0 0 1 -6 0 V12" fill="none" stroke="#9AA3AD" strokeWidth="3" strokeLinecap="round"/>
              <path d="M8 34 V10 a6 6 0 0 1 12 0 V26 a3 3 0 0 1 -6 0 V12" fill="none" stroke="#C8CED4" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <div style={{
              backgroundColor:'#FFFEFA',
              backgroundImage:'repeating-linear-gradient(to bottom, rgba(0,0,0,0.025) 0px, rgba(0,0,0,0.025) 1px, transparent 1px, transparent 4px)',
              clipPath:tornClipPath(9,3),
              filter:'drop-shadow(0 4px 8px rgba(26,22,18,0.3))',
              fontFamily:'JetBrains Mono,monospace',fontSize:13,minWidth:160,maxWidth:220,overflow:'hidden',
              padding:'18px 10px 20px',position:'relative'
            }}>
              {/* tape header */}
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',paddingBottom:4,marginBottom:4,borderBottom:'1px dashed #ccc'}}>
                <span style={{fontSize:10,letterSpacing:1.5,color:'#A89F92',fontWeight:700}}>ADDING MACHINE</span>
                <button onMouseDown={e=>e.stopPropagation()} onClick={()=>onDeleteTapeStamp(stamp.id)} style={{color:'#C9A227',lineHeight:1,fontSize:15,cursor:'pointer',background:'none',border:'none',padding:0}}>×</button>
              </div>
              {/* entries */}
              <div>
                {stamp.entries.map((en,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'2px 0',color:'#1A1612'}}>
                    <span style={{color:'#A89F92',fontSize:10,width:18}}>{i+1}</span>
                    <span style={{textAlign:'right',flex:1}}>{fmt(en.value)}</span>
                  </div>
                ))}
              </div>
              {/* dashed separator */}
              <div style={{borderTop:'1px dashed #ccc',margin:'4px 0'}}/>
              {/* total */}
              <div style={{display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:14}}>
                <span style={{color:'#7A5615'}}>Σ</span>
                <span style={{color:'#1A1612'}}>{fmt(total)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Move-to-Drawer Modal ──────────────────────────────────────────────────────

interface MoveToDrawerProps {
  files:DocFile[]; clients:string[]; rootPath:string
  onClose:()=>void; onMove:(destFolder:string)=>void
}

function MoveToDrawerModal({files,clients,rootPath,onClose,onMove}:MoveToDrawerProps){
  const [search,setSearch]=useState('')
  const [targetClient,setTargetClient]=useState<string|null>(null)
  const [folderTree,setFolderTree]=useState<(DocFile|DocFolder)[]>([])
  const [destFolder,setDestFolder]=useState<string|null>(null)
  const [loading,setLoading]=useState(false)
  const [expandedMoveFolders,setExpandedMoveFolders]=useState<Set<string>>(new Set())
  const [loadedMoveFolders,setLoadedMoveFolders]=useState<Set<string>>(new Set())
  const inputRef=useRef<HTMLInputElement>(null)

  function injectMoveChildren(tree:(DocFile|DocFolder)[],folderPath:string,children:(DocFile|DocFolder)[]): (DocFile|DocFolder)[] {
    return tree.map(n=>{
      if(n.type==='folder'){
        if(n.path===folderPath) return {...n,children}
        return {...n,children:injectMoveChildren(n.children,folderPath,children)}
      }
      return n
    })
  }

  useEffect(()=>{inputRef.current?.focus()},[])
  useEffect(()=>{
    if(!api||!targetClient) return
    setLoading(true); setDestFolder(null); setExpandedMoveFolders(new Set()); setLoadedMoveFolders(new Set())
    const cp=rootPath.replace(/\\$/,'')+`\\${targetClient}`
    api.listFolder(cp).then(tree=>{
      setFolderTree(tree); setDestFolder(cp); setLoading(false)
      const topFolders=tree.filter((n):n is DocFolder=>n.type==='folder')
      setExpandedMoveFolders(new Set(topFolders.map(f=>f.path)))
      Promise.all(topFolders.map(f=>api!.listFolder(f.path).then(ch=>({path:f.path,ch})))).then(loaded=>{
        setFolderTree(prev=>{
          let t=[...prev]
          for(const {path:p,ch} of loaded) t=injectMoveChildren(t,p,ch)
          return t
        })
        setLoadedMoveFolders(new Set(topFolders.map(f=>f.path)))
      })
    })
  },[targetClient,rootPath])

  async function toggleMoveFolder(p:string){
    setExpandedMoveFolders(prev=>{const n=new Set(prev);n.has(p)?n.delete(p):n.add(p);return n})
    if(!loadedMoveFolders.has(p)&&api){
      const children=await api.listFolder(p)
      setFolderTree(prev=>injectMoveChildren(prev,p,children))
      setLoadedMoveFolders(prev=>{const n=new Set(prev);n.add(p);return n})
    }
  }

  const filtered=clients.filter(c=>c.toLowerCase().includes(search.toLowerCase())).slice(0,60)

  function renderFolders(nodes:(DocFile|DocFolder)[],depth=0):React.ReactNode{
    return nodes.filter(n=>n.type==='folder').map(n=>{
      const f=n as DocFolder; const isSel=destFolder===f.path; const isOpen=expandedMoveFolders.has(f.path)
      return(
        <div key={f.path}>
          <div className="flex items-center gap-1 cursor-pointer" style={{paddingLeft:8+depth*16,paddingTop:6,paddingBottom:6,paddingRight:12,backgroundColor:isSel?C.ochreSoft:'transparent',borderLeft:isSel?`3px solid ${C.ochre}`:'3px solid transparent',color:isSel?C.ochreDeep:C.inkSoft}}>
            <button onClick={()=>toggleMoveFolder(f.path)} style={{color:C.inkFaint,flexShrink:0,display:'flex',alignItems:'center',padding:'0 2px'}}>
              {isOpen?<ChevronDown size={11}/>:<ChevronRight size={11}/>}
            </button>
            <FolderOpen size={13} style={{color:C.ochre,flexShrink:0}}/>
            <span className="sans truncate flex-1" style={{fontSize:13,fontWeight:isSel?600:400}} onClick={()=>setDestFolder(f.path)}>{f.name}</span>
          </div>
          {isOpen&&renderFolders(f.children,depth+1)}
        </div>
      )
    })
  }

  const cp=targetClient?rootPath.replace(/\\$/,'')+`\\${targetClient}`:null

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.5)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:680,maxHeight:'80vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <div>
            <div className="serif" style={{fontSize:14,fontWeight:600}}>Move to Another Drawer</div>
            <div className="mono truncate" style={{fontSize:10,color:C.inkFaint,marginTop:2,maxWidth:500}}>
              {files.length===1?files[0].name:`${files.length} files selected`}
            </div>
          </div>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="flex flex-1 overflow-hidden" style={{minHeight:0}}>
          <div className="flex flex-col flex-shrink-0" style={{width:260,borderRight:`1px solid ${C.rule}`}}>
            <div className="px-3 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded" style={{backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>
                <Search size={12} style={{color:C.inkMuted}}/>
                <input ref={inputRef} type="text" placeholder="Search clients…" value={search} onChange={e=>setSearch(e.target.value)} className="flex-1 outline-none bg-transparent sans" style={{fontSize:13,color:C.ink}}/>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" style={{scrollbarWidth:'thin'}}>
              {filtered.map(name=>{
                const isSel=targetClient===name
                return(
                  <div key={name} className="flex items-center gap-2 px-3 py-2 cursor-pointer" style={{backgroundColor:isSel?C.ochreSoft:'transparent',borderLeft:isSel?`3px solid ${C.ochre}`:'3px solid transparent'}} onClick={()=>{setTargetClient(name);setSearch(name)}}>
                    <div style={{width:24,height:24,backgroundColor:isSel?C.ochre:C.paper,border:`1px solid ${isSel?C.ochre:C.rule}`,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <span className="serif" style={{fontSize:12,fontWeight:600,color:isSel?C.ink:C.inkSoft}}>{name[0].toUpperCase()}</span>
                    </div>
                    <span className="truncate sans" style={{fontSize:13,fontWeight:isSel?600:400,color:C.ink}}>{name}</span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <div className="px-3 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
              <span className="serif" style={{fontSize:11,color:C.inkMuted,fontWeight:600,letterSpacing:0.8,textTransform:'uppercase'}}>
                {targetClient?`Folders — ${targetClient}`:'Select a client first'}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto" style={{scrollbarWidth:'thin'}}>
              {loading&&<div className="p-4 text-center" style={{color:C.inkFaint,fontSize:12}}>Loading…</div>}
              {!loading&&targetClient&&cp&&(
                <>
                  <div className="flex items-center gap-2 cursor-pointer" style={{paddingLeft:12,paddingTop:7,paddingBottom:7,paddingRight:12,backgroundColor:destFolder===cp?C.ochreSoft:'transparent',borderLeft:destFolder===cp?`3px solid ${C.ochre}`:'3px solid transparent'}} onClick={()=>setDestFolder(cp)}>
                    <FolderOpen size={13} style={{color:C.ochre,flexShrink:0}}/>
                    <span className="sans" style={{fontSize:13,fontWeight:destFolder===cp?600:400,color:destFolder===cp?C.ochreDeep:C.inkSoft}}>{targetClient} (root)</span>
                  </div>
                  {renderFolders(folderTree)}
                </>
              )}
              {!loading&&!targetClient&&<div className="p-4 text-center" style={{color:C.inkFaint,fontSize:12}}>Search and select a client on the left</div>}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <div className="mono truncate" style={{fontSize:11,color:C.inkMuted,flex:1,marginRight:16}}>{destFolder?`→ ${destFolder}`:'No folder selected'}</div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
            <button onClick={()=>{if(destFolder)onMove(destFolder)}} disabled={!destFolder} className="px-4 py-1.5 rounded sans" style={{fontSize:12,fontWeight:600,backgroundColor:destFolder?C.ink:'#ccc',color:C.paperLight,cursor:destFolder?'pointer':'not-allowed'}}>Move Here</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Scan Destination Modal ────────────────────────────────────────────────────

function ScanDestModal({clients,rootPath,defaultClient,defaultFolderPath,defaultAppendFile,onClose,onStarted,onFailed}:{clients:string[];rootPath:string;defaultClient?:string|null;defaultFolderPath?:string|null;defaultAppendFile?:{path:string;name:string}|null;onClose:()=>void;onStarted:()=>void;onFailed:()=>void}){
  const [search,setSearch]           = useState('')
  const [targetClient,setTargetClient] = useState<string|null>(null)
  const [folderTree,setFolderTree]   = useState<(DocFile|DocFolder)[]>([])
  const [destFolder,setDestFolder]   = useState<string|null>(null)
  const [appendMode,setAppendMode]   = useState(!!defaultAppendFile)
  const [loading,setLoading]         = useState(false)
  const [starting,setStarting]       = useState(false)
  const [useNativeUI,setUseNativeUI] = useState(true)
  const [scanDpi,setScanDpi]         = useState(200)
  const [colorMode,setColorMode]     = useState<'grayscale'|'color'|'bw'>('grayscale')
  const [skipBlank,setSkipBlank]     = useState(false)
  const [scanName,setScanName]       = useState('')
  const [nameButtons,setNameButtons] = useState<BmBtn[]>([])
  const [newNameBtn,setNewNameBtn]   = useState('')
  const inputRef                     = useRef<HTMLInputElement>(null)

  // Load saved preferences
  useEffect(()=>{
    api?.getConfig('scanShowUI').then(v=>{ if(v===false) setUseNativeUI(false) })
    api?.getConfig('scanDpi').then(v=>{ if(typeof v==='number') setScanDpi(v) })
    api?.getConfig('scanColorMode').then(v=>{ if(v==='color'||v==='bw'||v==='grayscale') setColorMode(v) })
    api?.getConfig('scanSkipBlank').then(v=>{ if(typeof v==='boolean') setSkipBlank(v) })
    api?.getConfig('scanNameButtons').then(v=>{ if(Array.isArray(v)) setNameButtons(v as BmBtn[]) })
    if(defaultClient) setTargetClient(defaultClient)
  },[])

  function saveNameButtons(btns:BmBtn[]){ setNameButtons(btns); api?.setConfig('scanNameButtons',btns) }
  function addNameButton(){ if(!newNameBtn.trim()) return; saveNameButtons([...nameButtons,{id:crypto.randomUUID(),label:newNameBtn.trim()}]); setNewNameBtn('') }

  const [expandedScanFolders,setExpandedScanFolders] = useState<Set<string>>(new Set())
  const [loadedScanFolders,setLoadedScanFolders]     = useState<Set<string>>(new Set())

  function injectScanChildren(tree:(DocFile|DocFolder)[],folderPath:string,children:(DocFile|DocFolder)[]): (DocFile|DocFolder)[] {
    return tree.map(n=>{
      if(n.type==='folder'){
        if(n.path===folderPath) return {...n,children}
        return {...n,children:injectScanChildren(n.children,folderPath,children)}
      }
      return n
    })
  }

  useEffect(()=>{inputRef.current?.focus()},[])
  useEffect(()=>{
    if(!api||!targetClient) return
    setLoading(true); setDestFolder(null); setExpandedScanFolders(new Set()); setLoadedScanFolders(new Set())
    const cp=rootPath.replace(/\\$/,'')+`\\${targetClient}`
    api.listFolder(cp).then(tree=>{
      setFolderTree(tree)
      setDestFolder(defaultFolderPath&&defaultFolderPath.startsWith(cp)?defaultFolderPath:cp)
      setLoading(false)
      // auto-expand top-level folders and load their children eagerly
      const topFolders=tree.filter((n):n is DocFolder=>n.type==='folder')
      setExpandedScanFolders(new Set(topFolders.map(f=>f.path)))
      Promise.all(topFolders.map(f=>api!.listFolder(f.path).then(ch=>({path:f.path,ch})))).then(loaded=>{
        setFolderTree(prev=>{
          let t=[...prev]
          for(const {path:p,ch} of loaded) t=injectScanChildren(t,p,ch)
          return t
        })
        setLoadedScanFolders(new Set(topFolders.map(f=>f.path)))
      })
    })
  },[targetClient,rootPath])

  async function toggleScanFolder(p:string){
    setExpandedScanFolders(prev=>{const n=new Set(prev);n.has(p)?n.delete(p):n.add(p);return n})
    if(!loadedScanFolders.has(p)&&api){
      const children=await api.listFolder(p)
      setFolderTree(prev=>injectScanChildren(prev,p,children))
      setLoadedScanFolders(prev=>{const n=new Set(prev);n.add(p);return n})
    }
  }

  const filtered=clients.filter(c=>c.toLowerCase().includes(search.toLowerCase())).slice(0,60)

  function renderFolders(nodes:(DocFile|DocFolder)[],depth=0):React.ReactNode{
    return nodes.filter(n=>n.type==='folder').map(n=>{
      const f=n as DocFolder; const isSel=destFolder===f.path; const isOpen=expandedScanFolders.has(f.path)
      return(
        <div key={f.path}>
          <div className="flex items-center gap-1 cursor-pointer"
            style={{paddingLeft:8+depth*16,paddingTop:6,paddingBottom:6,paddingRight:12,backgroundColor:isSel?C.ochreSoft:'transparent',borderLeft:isSel?`3px solid ${C.ochre}`:'3px solid transparent',color:isSel?C.ochreDeep:C.inkSoft}}>
            <button onClick={()=>toggleScanFolder(f.path)} style={{color:C.inkFaint,flexShrink:0,display:'flex',alignItems:'center',padding:'0 2px'}}>
              {isOpen?<ChevronDown size={11}/>:<ChevronRight size={11}/>}
            </button>
            <FolderOpen size={13} style={{color:C.ochre,flexShrink:0}}/>
            <span className="sans truncate flex-1" style={{fontSize:13,fontWeight:isSel?600:400}} onClick={()=>setDestFolder(f.path)}>{f.name}</span>
          </div>
          {isOpen&&renderFolders(f.children,depth+1)}
        </div>
      )
    })
  }

  const cp=targetClient?rootPath.replace(/\\$/,'')+`\\${targetClient}`:null

  async function handleStart(){
    if(!api||!destFolder) return
    setStarting(true)
    onStarted()  // set scanning=true immediately before the await
    onClose()    // close modal so user can see the scanning indicator
    const appendToPath=appendMode&&defaultAppendFile?defaultAppendFile.path:undefined
    const r=await api.startScan(destFolder,useNativeUI,scanDpi,colorMode,scanName.trim()||undefined,skipBlank,appendToPath)
    if(!r.ok){
      alert('Could not start scan: '+(r.error??'Unknown error'))
      onFailed()  // reset scanning=false if it errors
    }
    // on success, scan:fileArrived IPC event resets scanning=false
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.5)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:680,maxHeight:'80vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <div className="serif" style={{fontSize:14,fontWeight:600}}>Scan — Choose Destination</div>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="flex flex-1 overflow-hidden" style={{minHeight:0}}>
          <div className="flex flex-col flex-shrink-0" style={{width:260,borderRight:`1px solid ${C.rule}`}}>
            <div className="px-3 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded" style={{backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>
                <Search size={12} style={{color:C.inkMuted}}/>
                <input ref={inputRef} type="text" placeholder="Search clients…" value={search} onChange={e=>setSearch(e.target.value)} className="flex-1 outline-none bg-transparent sans" style={{fontSize:13,color:C.ink}}/>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.map(name=>{
                const isSel=targetClient===name
                return(
                  <div key={name} className="flex items-center gap-2 px-3 py-2 cursor-pointer" style={{backgroundColor:isSel?C.ochreSoft:'transparent',borderLeft:isSel?`3px solid ${C.ochre}`:'3px solid transparent'}} onClick={()=>{setTargetClient(name);setSearch(name)}}>
                    <div style={{width:24,height:24,backgroundColor:isSel?C.ochre:C.paper,border:`1px solid ${isSel?C.ochre:C.rule}`,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <span className="serif" style={{fontSize:12,fontWeight:600,color:isSel?C.ink:C.inkSoft}}>{name[0].toUpperCase()}</span>
                    </div>
                    <span className="truncate sans" style={{fontSize:13,fontWeight:isSel?600:400,color:C.ink}}>{name}</span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <div className="px-3 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
              <span className="serif" style={{fontSize:11,color:C.inkMuted,fontWeight:600,letterSpacing:0.8,textTransform:'uppercase'}}>
                {targetClient?`Folders — ${targetClient}`:'Select a client first'}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading&&<div className="p-4 text-center" style={{color:C.inkFaint,fontSize:12}}>Loading…</div>}
              {!loading&&targetClient&&cp&&(
                <>
                  <div className="flex items-center gap-2 cursor-pointer" style={{paddingLeft:12,paddingTop:7,paddingBottom:7,paddingRight:12,backgroundColor:destFolder===cp?C.ochreSoft:'transparent',borderLeft:destFolder===cp?`3px solid ${C.ochre}`:'3px solid transparent'}} onClick={()=>setDestFolder(cp)}>
                    <FolderOpen size={13} style={{color:C.ochre,flexShrink:0}}/>
                    <span className="sans" style={{fontSize:13,fontWeight:destFolder===cp?600:400,color:destFolder===cp?C.ochreDeep:C.inkSoft}}>{targetClient} (root)</span>
                  </div>
                  {renderFolders(folderTree)}
                </>
              )}
              {!loading&&!targetClient&&<div className="p-4 text-center" style={{color:C.inkFaint,fontSize:12}}>Search and select a client on the left</div>}
            </div>
          </div>
        </div>
        <div className="px-5 py-3 flex-shrink-0" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          {defaultAppendFile&&(
            <label className="flex items-center gap-2 mb-2.5 px-2.5 py-1.5 rounded cursor-pointer" style={{backgroundColor:appendMode?C.ochreSoft:C.paper,border:`1px solid ${appendMode?C.ochre:C.rule}`}}>
              <input type="checkbox" checked={appendMode} onChange={e=>setAppendMode(e.target.checked)}/>
              <span className="sans truncate" style={{fontSize:12,color:appendMode?C.ochreDeep:C.inkSoft,fontWeight:appendMode?600:400}}>
                Append new scan to the end of "{defaultAppendFile.name}" (currently open)
              </span>
            </label>
          )}
          <div className="flex items-center justify-between mb-2">
            <div className="mono truncate" style={{fontSize:11,color:C.inkMuted,flex:1,marginRight:16}}>
              {appendMode&&defaultAppendFile?`→ appending to ${defaultAppendFile.name}`:destFolder?`→ ${destFolder}`:'No folder selected'}
            </div>
          </div>
          {/* File name input + name buttons */}
          <div className="mb-2.5" style={{opacity:appendMode?0.4:1,pointerEvents:appendMode?'none':'auto'}}>
            <input type="text" placeholder="File name (optional — leave blank for auto)" value={scanName} onChange={e=>setScanName(e.target.value)}
              className="w-full outline-none sans px-2 py-1 rounded mb-1.5"
              style={{fontSize:12,backgroundColor:C.paper,border:`1px solid ${C.rule}`,color:C.ink}}/>
            <div className="flex items-center flex-wrap gap-1.5">
              <button onClick={()=>setScanName(todayStr())}
                className="px-2 py-1 rounded sans flex-shrink-0"
                style={{fontSize:11,fontWeight:600,backgroundColor:C.paper,border:`1px solid ${C.rule}`,color:C.inkSoft}}>
                📅 Today
              </button>
              {nameButtons.map(b=>(
                <button key={b.id} onClick={()=>setScanName(b.label)}
                  className="px-2 py-1 rounded sans flex-shrink-0"
                  style={{fontSize:11,fontWeight:600,backgroundColor:scanName===b.label?C.ochreSoft:C.paper,border:`1px solid ${scanName===b.label?C.ochre:C.rule}`,color:scanName===b.label?C.ochreDeep:C.inkSoft}}>
                  {b.label}
                </button>
              ))}
              <div className="flex items-center gap-1 flex-shrink-0" style={{borderLeft:`1px solid ${C.rule}`,paddingLeft:6}}>
                <input type="text" placeholder="+ name btn" value={newNameBtn} onChange={e=>setNewNameBtn(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter')addNameButton()}}
                  className="outline-none sans px-1.5 py-1 rounded"
                  style={{fontSize:11,width:90,backgroundColor:C.paper,border:`1px solid ${C.rule}`,color:C.ink}}/>
                <button onClick={addNameButton} style={{fontSize:13,color:C.ochre,fontWeight:700,padding:'0 4px'}}>+</button>
                {nameButtons.length>0&&(
                  <button onClick={()=>saveNameButtons(nameButtons.slice(0,-1))} style={{fontSize:10,color:C.inkFaint,padding:'0 2px'}} title="Remove last">✕</button>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 mb-2.5">
            {/* DPI */}
            <div className="flex items-center gap-2">
              <span className="sans" style={{fontSize:11,color:C.inkMuted,whiteSpace:'nowrap'}}>Resolution</span>
              {([150,200,300] as const).map(d=>(
                <button key={d} onClick={()=>{setScanDpi(d);api?.setConfig('scanDpi',d)}}
                  className="px-2 py-0.5 rounded sans"
                  style={{fontSize:11,fontWeight:scanDpi===d?700:400,border:`1px solid ${scanDpi===d?C.ochre:C.rule}`,backgroundColor:scanDpi===d?C.ochreSoft:C.paper,color:scanDpi===d?C.ochreDeep:C.inkSoft}}>
                  {d} dpi
                </button>
              ))}
            </div>
            {/* Color mode */}
            <div className="flex items-center gap-2">
              <span className="sans" style={{fontSize:11,color:C.inkMuted,whiteSpace:'nowrap'}}>Color</span>
              {(['grayscale','bw','color'] as const).map(m=>{
                const label={grayscale:'Grayscale',bw:'B&W',color:'Color'}[m]
                return(
                  <button key={m} onClick={()=>{setColorMode(m);api?.setConfig('scanColorMode',m)}}
                    className="px-2 py-0.5 rounded sans"
                    style={{fontSize:11,fontWeight:colorMode===m?700:400,border:`1px solid ${colorMode===m?C.ochre:C.rule}`,backgroundColor:colorMode===m?C.ochreSoft:C.paper,color:colorMode===m?C.ochreDeep:C.inkSoft}}>
                    {label}
                  </button>
                )
              })}
            </div>
            {/* Skip blank pages */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{fontSize:11}}>
              <input type="checkbox" checked={skipBlank} onChange={e=>{setSkipBlank(e.target.checked);api?.setConfig('scanSkipBlank',e.target.checked)}}/>
              <span className="sans" style={{color:C.inkMuted}}>Skip blank pages</span>
            </label>
          </div>
          <div className="flex items-center justify-between">
            {/* UI toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none" style={{fontSize:12}}>
              <div onClick={()=>{const v=!useNativeUI;setUseNativeUI(v);api?.setConfig('scanShowUI',v)}}
                style={{width:34,height:18,borderRadius:9,backgroundColor:useNativeUI?C.ochre:C.ruleSoft,position:'relative',cursor:'pointer',transition:'background-color 0.2s',flexShrink:0}}>
                <div style={{position:'absolute',top:2,left:useNativeUI?16:2,width:14,height:14,borderRadius:7,backgroundColor:'white',transition:'left 0.2s',boxShadow:'0 1px 3px rgba(0,0,0,0.2)'}}/>
              </div>
              <span className="sans" style={{color:C.inkMuted}}>
                {useNativeUI?'Show scanner controls':'Quick scan (silent)'}
              </span>
            </label>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
              <button onClick={handleStart} disabled={!destFolder||starting} className="px-4 py-1.5 rounded sans"
                style={{fontSize:12,fontWeight:600,backgroundColor:destFolder&&!starting?C.ink:'#ccc',color:C.paperLight,cursor:destFolder&&!starting?'pointer':'not-allowed'}}>
                {starting?'Starting…':'Scan Here'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Scan Settings Modal ───────────────────────────────────────────────────────

function ScanSettingsModal({onClose}:{onClose:()=>void}){
  const [devices,setDevices]   = useState<{ID:string;Name:string;driver?:string}[]>([])
  const [loading,setLoading]   = useState(true)
  const [error,setError]       = useState<string|null>(null)

  function refresh(){
    setLoading(true); setError(null)
    api?.listScanDevices().then(r=>{
      if(r.ok) setDevices(r.devices)
      else setError(r.error??'Could not list devices')
      setLoading(false)
    })
  }

  useEffect(()=>{ refresh() },[])

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:460,backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Scanner Settings</span>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Detected TWAIN Devices</div>
            <button onClick={refresh} className="sans px-2 py-1 rounded" style={{fontSize:11,color:C.ochreDeep,backgroundColor:C.ochreSoft,border:`1px solid ${C.ochreLight}`}}>Refresh</button>
          </div>
          {loading&&<div style={{fontSize:12,color:C.inkFaint,padding:'8px 0'}}>Scanning for devices…</div>}
          {!loading&&error&&<div style={{fontSize:12,color:'#B5443A',padding:'8px 0'}}>{error}</div>}
          {!loading&&!error&&devices.length===0&&(
            <div style={{fontSize:12,color:C.inkFaint,padding:'8px 0'}}>No devices found (checked TWAIN and WIA). Make sure your scanner is connected and its driver is installed.</div>
          )}
          {!loading&&devices.map(d=>(
            <div key={d.ID} className="flex items-center gap-2 px-3 py-2 rounded" style={{backgroundColor:C.paperDeep,border:`1px solid ${C.ruleSoft}`}}>
              <ScanLine size={13} style={{color:C.ochre,flexShrink:0}}/>
              <span className="sans flex-1" style={{fontSize:13,color:C.ink}}>{d.Name}</span>
              {d.driver&&<span className="mono" style={{fontSize:9,padding:'1px 5px',borderRadius:3,border:`1px solid ${C.rule}`,color:C.inkMuted,textTransform:'uppercase'}}>{d.driver}</span>}
            </div>
          ))}
          <div style={{fontSize:11,color:C.inkFaint,lineHeight:1.5,borderTop:`1px solid ${C.ruleSoft}`,paddingTop:12}}>
            The scanner UI toggle on the Scan dialog lets you choose between <strong>Show scanner controls</strong> (opens your scanner's full interface) and <strong>Quick scan</strong> (scans silently using your saved scanner profile). Your preference is remembered between sessions.
          </div>
        </div>
        <div className="px-5 py-3 flex justify-end" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── User Name Prompt Modal ────────────────────────────────────────────────────

function UserNameModal({initialValue,onSave}:{initialValue:string;onSave:(name:string)=>void}){
  const [value,setValue]=useState(initialValue)
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.55)'}}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:380,backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.3)',border:`1px solid ${C.rule}`}}>
        <div className="px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Who's working in this app?</span>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <div style={{fontSize:12,color:C.inkMuted,lineHeight:1.5}}>
            Enter your name so tickmarks, signoffs, and added files can be attributed to you. We recommend <strong>First Last</strong> (e.g. "Billy Bellomy").
          </div>
          <input autoFocus value={value} onChange={e=>setValue(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter'&&value.trim()) onSave(value)}}
            placeholder="First Last"
            className="w-full px-3 py-2 rounded sans" style={{fontSize:14,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}/>
        </div>
        <div className="px-5 py-3 flex justify-end" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <button onClick={()=>value.trim()&&onSave(value)} disabled={!value.trim()} className="px-4 py-1.5 rounded sans" style={{fontSize:12,backgroundColor:C.ochre,color:'#fff',fontWeight:600,opacity:value.trim()?1:0.5}}>Continue</button>
        </div>
      </div>
    </div>
  )
}

// ── Magic Link Settings Modal ─────────────────────────────────────────────────

function MagicLinkSettingsModal({onClose}:{onClose:()=>void}){
  const [workerUrl,setWorkerUrl]   = useState('')
  const [uploadSecret,setUploadSecret] = useState('')
  const [hasSecret,setHasSecret]   = useState(false)
  const [saving,setSaving]         = useState(false)
  const [saved,setSaved]           = useState(false)

  useEffect(()=>{
    api?.getMagicLinkConfig().then(c=>{ setWorkerUrl(c.workerUrl||DEFAULT_WORKER_URL); setHasSecret(c.hasUploadSecret) })
  },[])

  async function handleSave(){
    setSaving(true)
    await api?.setSecret('workerUrl',workerUrl.trim())
    if(uploadSecret.trim()) await api?.setSecret('uploadSecret',uploadSecret.trim())
    setSaving(false); setSaved(true)
    setTimeout(()=>setSaved(false),2000)
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:460,backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Magic Link Settings</span>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Worker URL</label>
            <input value={workerUrl} onChange={e=>setWorkerUrl(e.target.value)} placeholder="https://bellomy-magic-links.yoursubdomain.workers.dev"
              className="w-full mt-1 px-3 py-2 rounded sans" style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}/>
          </div>
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>
              Upload Secret {hasSecret&&<span style={{color:C.ochreDeep}}>(already set — leave blank to keep it)</span>}
            </label>
            <input type="password" value={uploadSecret} onChange={e=>setUploadSecret(e.target.value)} placeholder={hasSecret?'••••••••':'paste the secret from wrangler secret put'}
              className="w-full mt-1 px-3 py-2 rounded sans" style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}/>
          </div>
          <div style={{fontSize:11,color:C.inkFaint,lineHeight:1.5}}>
            These values come from deploying the Cloudflare Worker (see <span className="mono">cloudflare-worker/README.md</span>). Links sent through this app are single-view and self-delete after the chosen expiration.
          </div>
        </div>
        <div className="px-5 py-3 flex justify-end gap-2" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          {saved&&<span className="sans" style={{fontSize:12,color:C.ochreDeep,alignSelf:'center'}}>Saved ✓</span>}
          <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Close</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 rounded sans" style={{fontSize:12,backgroundColor:C.ochre,color:'#fff',fontWeight:600}}>{saving?'Saving…':'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Email Magic Link Modal ────────────────────────────────────────────────────

interface EmailItem { name:string; path?:string; bytes?:ArrayBuffer }

function EmailLinkModal({initialItems,clientFiles,author,onClose}:{initialItems:EmailItem[];clientFiles:DocFile[];author:string;onClose:()=>void}){
  const [selected,setSelected] = useState<Set<string>>(new Set(initialItems.map(i=>i.name)))
  const [pageRanges,setPageRanges] = useState<Record<string,string>>({})
  const [expiresDays,setExpiresDays] = useState(7)
  const [sending,setSending]   = useState(false)
  const [error,setError]       = useState<string|null>(null)

  const extraFiles=clientFiles.filter(f=>!initialItems.some(i=>i.name===f.name))
  const allItems:EmailItem[]=[...initialItems,...extraFiles.map(f=>({name:f.name,path:f.path}))]

  async function handleSend(){
    setSending(true); setError(null)
    const items=allItems.filter(i=>selected.has(i.name)).map(i=>({
      ...i,
      pages: pageRanges[i.name]?.trim()||undefined,
    }))
    if(items.length===0){ setError('Select at least one file.'); setSending(false); return }
    const r=await api?.sendMagicLinks(items,expiresDays)
    setSending(false)
    if(!r?.ok){ setError(r?.error??'Could not send magic links.'); return }
    const failed=(r.results??[]).filter(x=>!x.url)
    if(failed.length){ setError(failed.map(f=>`${f.name}: ${f.error??'unknown error'}`).join('\n')); }
    const links=(r.results??[]).filter(x=>x.url)
    if(links.length===0) return
    const expiresLabel=expiresDays===1?'1 day':`${expiresDays} days`
    const body=[
      `Hello,`,
      ``,
      `Please find your document${links.length>1?'s':''} below. ${links.length>1?'These links':'This link'} will expire in ${expiresLabel} and can only be opened once, so please save a copy after viewing.`,
      ``,
      ...links.flatMap(l=>[`${l.name}:`,l.url,``]),
      ``,
      `Thank you,`,
    ].join('\n')
    const subject=`${author} has shared a file with you`
    const mailto=`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    await api?.openExternal(mailto)
    onClose()
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:460,maxHeight:'80vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Email Magic Link</span>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-3 overflow-y-auto">
          <div className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Files to send</div>
          <div className="flex flex-col gap-1" style={{maxHeight:280,overflowY:'auto'}}>
            {allItems.map(item=>{
              const isPdf=item.name.toLowerCase().endsWith('.pdf')
              const isSel=selected.has(item.name)
              return(
                <div key={item.name} className="rounded" style={{backgroundColor:C.paperDeep}}>
                  <label className="flex items-center gap-2 px-2 py-1.5" style={{cursor:'pointer'}}>
                    <input type="checkbox" checked={isSel} onChange={()=>setSelected(prev=>{
                      const next=new Set(prev)
                      if(next.has(item.name)) next.delete(item.name); else next.add(item.name)
                      return next
                    })}/>
                    <span className="sans truncate" style={{fontSize:13,color:C.ink}}>{item.name}</span>
                  </label>
                  {isSel&&isPdf&&(
                    <div className="flex items-center gap-2 px-2 pb-1.5" onClick={e=>e.stopPropagation()}>
                      <span className="sans" style={{fontSize:11,color:C.inkMuted,whiteSpace:'nowrap'}}>Pages:</span>
                      <input
                        className="flex-1 rounded px-2 py-0.5 sans"
                        style={{fontSize:11,border:`1px solid ${C.rule}`,backgroundColor:C.paper,color:C.ink}}
                        placeholder="all  (e.g. 1-3, 5, 8)"
                        value={pageRanges[item.name]??''}
                        onChange={e=>setPageRanges(prev=>({...prev,[item.name]:e.target.value}))}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Link expires after</label>
            <select value={expiresDays} onChange={e=>setExpiresDays(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 rounded sans" style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}>
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
          <div style={{fontSize:11,color:C.inkFaint}}>Links can only be opened once and self-delete after that or after expiry.</div>
          {error&&<div style={{fontSize:12,color:'#B5443A',whiteSpace:'pre-wrap'}}>{error}</div>}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
          <button onClick={handleSend} disabled={sending} className="px-4 py-1.5 rounded sans" style={{fontSize:12,backgroundColor:C.ochre,color:'#fff',fontWeight:600}}>{sending?'Sending…':'Send'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Request Documents Modal ───────────────────────────────────────────────────

function RequestUploadModal({folderPath,folderName,author,onClose,onCreated}:{folderPath:string;folderName:string;author:string;onClose:()=>void;onCreated:()=>void}){
  const [label,setLabel]=useState(`Documents from ${folderName}`)
  const [instructions,setInstructions]=useState('')
  const [expiresDays,setExpiresDays]=useState(30)
  const [creating,setCreating]=useState(false)
  const [error,setError]=useState<string|null>(null)

  async function handleCreate(){
    setCreating(true); setError(null)
    const r=await api?.createUploadRequest(label.trim()||folderName,instructions.trim(),expiresDays,folderPath)
    setCreating(false)
    if(!r?.ok){ setError(r?.error??'Could not create upload link.'); return }
    const subject=`${author} has requested documents`
    const body=[
      `Hello,`,``,
      `Please upload the requested documents using the secure link below:`,``,
      r.url!,``,
      `This link will expire in ${expiresDays} days.`,``,
      `Thank you,`,
    ].join('\n')
    await api?.openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)
    onCreated()
    onClose()
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:460,backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Request Documents from Client</span>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Destination folder</label>
            <div className="mono mt-1" style={{fontSize:11,color:C.inkFaint,padding:'6px 10px',backgroundColor:C.paperDeep,borderRadius:4}}>{folderPath}</div>
          </div>
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Request label</label>
            <input className="w-full mt-1 px-3 py-2 rounded sans" style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper,color:C.ink}}
              value={label} onChange={e=>setLabel(e.target.value)} placeholder="e.g. 2025 Tax Documents"/>
          </div>
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Instructions to client <span style={{fontWeight:400,textTransform:'none'}}>(optional)</span></label>
            <textarea className="w-full mt-1 px-3 py-2 rounded sans" rows={3} style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper,color:C.ink,resize:'vertical'}}
              value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="e.g. Please upload your W-2s, 1099s, and any other income documents."/>
          </div>
          <div>
            <label className="sans" style={{fontSize:11,color:C.inkMuted,fontWeight:600,textTransform:'uppercase',letterSpacing:0.5}}>Link expires after</label>
            <select value={expiresDays} onChange={e=>setExpiresDays(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 rounded sans" style={{fontSize:13,border:`1px solid ${C.rule}`,backgroundColor:C.paper}}>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          <div style={{fontSize:11,color:C.inkFaint}}>Files uploaded by the client will be saved directly into the destination folder.</div>
          {error&&<div style={{fontSize:12,color:'#B5443A'}}>{error}</div>}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
          <button onClick={handleCreate} disabled={creating} className="px-4 py-1.5 rounded sans" style={{fontSize:12,backgroundColor:C.ochre,color:'#fff',fontWeight:600}}>{creating?'Creating…':'Create Link & Email'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Upload Inbox Modal ────────────────────────────────────────────────────────

function UploadInboxModal({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}){
  type UploadRequest={label:string;folderPath:string;url:string;createdAt:string;expiresDays:number}
  type PendingFile={token:string;filename:string;requestLabel:string}
  const [requests,setRequests]=useState<Record<string,UploadRequest>>({})
  const [pendingFiles,setPendingFiles]=useState<PendingFile[]>([])
  const [saving,setSaving]=useState<Set<string>>(new Set())
  const [loading,setLoading]=useState(true)

  useEffect(()=>{
    async function load(){
      setLoading(true)
      const reqs=await api?.listUploadRequests()??{}
      setRequests(reqs)
      const pending:PendingFile[]=[]
      for(const [token,req] of Object.entries(reqs)){
        const r=await api?.checkUploads(token)
        if(r?.ok&&r.files) r.files.forEach(f=>pending.push({token,filename:f,requestLabel:req.label}))
      }
      setPendingFiles(pending)
      setLoading(false)
    }
    load()
  },[])

  async function saveFile(pf:PendingFile){
    setSaving(prev=>new Set(prev).add(pf.token+'/'+pf.filename))
    const r=await api?.downloadAndSaveUpload(pf.token,pf.filename)
    if(!r?.ok){ alert('Could not save file: '+(r?.error??'')); }
    else{
      setPendingFiles(prev=>prev.filter(x=>!(x.token===pf.token&&x.filename===pf.filename)))
      onSaved()
    }
    setSaving(prev=>{const n=new Set(prev);n.delete(pf.token+'/'+pf.filename);return n})
  }

  async function revokeRequest(token:string){
    if(!confirm('Revoke this upload link? The client will no longer be able to upload.')) return
    await api?.revokeUploadRequest(token)
    setRequests(prev=>{const n={...prev};delete n[token];return n})
    setPendingFiles(prev=>prev.filter(x=>x.token!==token))
  }

  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={onClose}>
      <div className="flex flex-col rounded overflow-hidden" style={{width:540,maxHeight:'80vh',backgroundColor:C.paperLight,boxShadow:'0 8px 40px rgba(26,22,18,0.25)',border:`1px solid ${C.rule}`}} onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3" style={{backgroundColor:C.ink,color:C.paperLight}}>
          <span className="serif" style={{fontSize:14,fontWeight:600}}>Client Upload Inbox</span>
          <button onClick={onClose} style={{color:C.inkFaint,fontSize:20,lineHeight:1}}>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {loading&&<div className="sans" style={{fontSize:13,color:C.inkFaint,textAlign:'center',padding:24}}>Checking for uploads…</div>}
          {!loading&&pendingFiles.length>0&&(
            <div>
              <div className="sans mb-2" style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:.5,color:C.inkMuted}}>Pending uploads</div>
              <div className="flex flex-col gap-1">
                {pendingFiles.map(pf=>{
                  const key=pf.token+'/'+pf.filename
                  const isSaving=saving.has(key)
                  return(
                    <div key={key} className="flex items-center gap-3 px-3 py-2 rounded" style={{backgroundColor:C.paperDeep,border:`1px solid ${C.rule}`}}>
                      <div className="flex-1 min-w-0">
                        <div className="sans truncate" style={{fontSize:13,color:C.ink,fontWeight:500}}>{pf.filename}</div>
                        <div className="sans" style={{fontSize:11,color:C.inkFaint}}>{pf.requestLabel}</div>
                      </div>
                      <button onClick={()=>saveFile(pf)} disabled={isSaving}
                        className="px-3 py-1 rounded sans" style={{fontSize:11,fontWeight:600,backgroundColor:C.ochre,color:'#fff',flexShrink:0}}>
                        {isSaving?'Saving…':'Save to Folder'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {!loading&&pendingFiles.length===0&&<div className="sans" style={{fontSize:13,color:C.inkFaint,textAlign:'center',padding:16}}>No pending uploads.</div>}

          {!loading&&Object.keys(requests).length>0&&(
            <div>
              <div className="sans mb-2" style={{fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:.5,color:C.inkMuted}}>Active upload links</div>
              <div className="flex flex-col gap-1">
                {Object.entries(requests).map(([token,req])=>{
                  const expires=new Date(new Date(req.createdAt).getTime()+req.expiresDays*86400000)
                  const expired=Date.now()>expires.getTime()
                  return(
                    <div key={token} className="flex items-center gap-3 px-3 py-2 rounded" style={{backgroundColor:C.paperDeep,border:`1px solid ${C.rule}`}}>
                      <div className="flex-1 min-w-0">
                        <div className="sans" style={{fontSize:13,color:C.ink,fontWeight:500}}>{req.label}</div>
                        <div className="mono truncate" style={{fontSize:10,color:C.inkFaint}}>{req.folderPath}</div>
                        <div className="sans" style={{fontSize:11,color:expired?'#B5443A':C.inkFaint}}>{expired?'Expired':'Expires'} {expires.toLocaleDateString()}</div>
                      </div>
                      <button onClick={()=>api?.openExternal(req.url)} className="px-2 py-1 rounded sans" style={{fontSize:11,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper,flexShrink:0}}>Copy Link</button>
                      <button onClick={()=>revokeRequest(token)} className="px-2 py-1 rounded sans" style={{fontSize:11,color:'#B5443A',flexShrink:0}}>Revoke</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 flex justify-end" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
          <button onClick={onClose} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App(){
  const [rootPath,setRootPath]             = useState('Z:\\')
  const [clients,setClients]               = useState<string[]>([])
  const [selectedClient,setSelectedClient] = useState<string|null>(null)
  const [docTree,setDocTree]               = useState<(DocFile|DocFolder)[]>([])
  const [activeFolder,setActiveFolder]     = useState<{name:string;path:string}|null>(null)
  const [expandedFolders,setExpandedFolders] = useState<Set<string>>(new Set())
  const [loadedFolderPaths,setLoadedFolderPaths] = useState<Set<string>>(new Set())
  const [selectedFile,setSelectedFile]     = useState<DocFile|null>(null)
  const [pdfBytes,setPdfBytes]             = useState<ArrayBuffer|null>(null)
  const [imageUrl,setImageUrl]             = useState<string|null>(null)
  const [annotations,setAnnotations]       = useState<Annotations>({tickmarks:[],signoffs:[]})
  const [pageCount,setPageCount]           = useState(1)
  const [currentPage,setCurrentPage]       = useState(1)
  const [zoom,setZoom]                     = useState(100)
  const [pageSize,setPageSize]             = useState({w:612,h:792})
  const [activeMark,setActiveMark]         = useState('')
  const [refreshing,setRefreshing]         = useState(false)
  const [leftOpen,setLeftOpen]             = useState(true)
  const [rightOpen,setRightOpen]           = useState(true)
  const [rightTab,setRightTab]             = useState<'notes'|'xref'|'signoff'>('notes')
  const [showCalculator,setShowCalculator] = useState(false)
  const [search,setSearch]                 = useState('')
  const clientSearchRef                    = useRef<HTMLInputElement>(null)
  const [dragSrc,setDragSrc]               = useState<string|null>(null)
  const [dragOver,setDragOver]             = useState<string|null>(null)
  const [ctxMenu,setCtxMenu]               = useState<{x:number;y:number;file:DocFile}|null>(null)
  const [ctxFolder,setCtxFolder]           = useState<{x:number;y:number;folder:DocFolder;hoistOnly?:boolean}|null>(null)
  const [newSubfolder,setNewSubfolder]     = useState<{parent:DocFolder;value:string}|null>(null)
  async function handleCreateSubfolder(){
    if(!api||!newSubfolder) return
    const r=await api.createFolder(newSubfolder.parent.path,newSubfolder.value)
    if(!r.ok){ alert('Could not create folder: '+(r.error??'Unknown error')); return }
    setNewSubfolder(null)
    refreshDocs(300)
  }
  const [renaming,setRenaming]             = useState<{file:DocFile;value:string}|null>(null)
  const [hoisted,setHoisted]               = useState<{folder:string;path:string}|null>(null)
  const [hoisting,setHoisting]             = useState(false)
  const [noteText,setNoteText]             = useState<string|null>(null)
  const [noteLoaded,setNoteLoaded]         = useState(false)
  const [noteSaving,setNoteSaving]         = useState(false)
  const noteSaveTimer                      = useRef<ReturnType<typeof setTimeout>|null>(null)
  const [clientInfo,setClientInfo]         = useState<{loading:boolean;name?:string;idLabel?:string;idValue?:string;spouseSsn?:string;formName?:string;error?:string}|null>(null)
  const [leftWidth,setLeftWidth]           = useState(240)
  const [resizingLeft,setResizingLeft]     = useState(false)

  // Load/save left-panel width
  useEffect(()=>{
    api?.getConfig('leftPanelWidth').then(v=>{ if(typeof v==='number'&&v>0) setLeftWidth(v) })
  },[])

  // Load/save root path
  useEffect(()=>{
    api?.getConfig('rootPath').then(v=>{ if(typeof v==='string'&&v) setRootPath(v) })
  },[])

  function changeRootPath(p:string){
    setRootPath(p)
    setSelectedClient(null)
    setSelectedFile(null)
    api?.setConfig('rootPath',p)
  }

  function startResizeLeft(e:React.MouseEvent){
    e.preventDefault()
    setResizingLeft(true)
    function onMove(ev:MouseEvent){
      setLeftWidth(Math.max(160,Math.min(560,ev.clientX)))
    }
    function onUp(){
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
      setResizingLeft(false)
      setLeftWidth(w=>{ api?.setConfig('leftPanelWidth',w); return w })
    }
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)
  }
  const [moveDrawer,setMoveDrawer]         = useState<DocFile[]|null>(null)
  const [editFileModal,setEditFileModal]   = useState<DocFile|null>(null)
  const [editFolderModal,setEditFolderModal] = useState<DocFolder|null>(null)
  const [clipboard,setClipboard]           = useState<DocFile|null>(null)
  const [multiSelect,setMultiSelect]       = useState<DocFile[]>([])
  // bookmarks: undefined = not checked, 'loading' = in progress, 'none' = no bookmarks, Bookmark[] = loaded
  const [fileBookmarks,setFileBookmarks]   = useState<Record<string,Bookmark[]|'loading'|'none'>>({})
  const [expandedBookmarks,setExpandedBookmarks] = useState<Set<string>>(new Set())
  const [showScanModal,setShowScanModal]   = useState(false)
  const [showScanSettings,setShowScanSettings] = useState(false)
  const [scanToasts,setScanToasts]         = useState<{id:string;name:string}[]>([])
  const [scanning,setScanning]             = useState(false)
  const [scanPage,setScanPage]             = useState(0)
  const pendingPageRef = useRef<number|null>(null)
  const pdfScrollRef = useRef<HTMLDivElement|null>(null)
  const wheelLockRef = useRef(false)
  const refreshDocsRef = useRef<(delay?:number)=>void>(()=>{})
  const [tapeEntries,setTapeEntries] = useState<{id:string;value:number}[]>([])
  const [tapeInput,setTapeInput]     = useState('')
  const tapeInputRef = useRef<HTMLInputElement|null>(null)
  const [author,setAuthorState]=useState('')
  const [showNamePrompt,setShowNamePrompt]=useState(false)
  const [appVersion,setAppVersion]=useState('')
  const [updateStatus,setUpdateStatus]=useState<{message:string;type:'info'|'success'|'error'}|null>(null)
  const [updateReady,setUpdateReady]=useState(false)
  const [appBookmarkButtons,setAppBookmarkButtons]=useState<BmBtn[]>([])
  useEffect(()=>{ api?.getVersion().then(v=>setAppVersion(v)) },[api])
  useEffect(()=>{ api?.onUpdateDownloaded(()=>setUpdateReady(true)) },[api])
  useEffect(()=>{
    api?.getConfig('bookmarkButtons').then(b=>{ if(Array.isArray(b)) setAppBookmarkButtons(b as BmBtn[]) })
  },[])
  useEffect(()=>{
    api?.getConfig('userName').then(v=>{
      if(typeof v==='string'&&v.trim()) setAuthorState(v.trim())
      else setShowNamePrompt(true)
    })
  },[])
  function saveUserName(name:string){
    const trimmed=name.trim()
    if(!trimmed) return
    setAuthorState(trimmed)
    api?.setConfig('userName',trimmed)
    setShowNamePrompt(false)
  }
  const authorRef=useRef('')
  useEffect(()=>{authorRef.current=author},[author])

  // Refs to avoid stale closures inside refreshDocs
  const expandedFoldersRef = useRef<Set<string>>(new Set())
  useEffect(()=>{expandedFoldersRef.current=expandedFolders},[expandedFolders])
  const loadedFolderPathsRef = useRef<Set<string>>(new Set())
  useEffect(()=>{loadedFolderPathsRef.current=loadedFolderPaths},[loadedFolderPaths])

  // Load clients
  useEffect(()=>{
    if(!api) return
    api.listClients(rootPath).then(setClients)
  },[rootPath])

  // Helper: remove specific file paths anywhere in the tree (used for optimistic UI updates after move)
  function removeFilesFromTree(tree:(DocFile|DocFolder)[], paths:string[]): (DocFile|DocFolder)[] {
    return tree
      .filter(n=>!(n.type==='file'&&paths.includes(n.path)))
      .map(n=>n.type==='folder'?{...n,children:removeFilesFromTree(n.children,paths)}:n)
  }

  // Helper: find the files in the same folder as filePath (for "add more files" pickers)
  function findSiblingFiles(tree:(DocFile|DocFolder)[], filePath:string): DocFile[] {
    function search(nodes:(DocFile|DocFolder)[]):DocFile[]|null {
      if(nodes.some(n=>n.type==='file'&&n.path===filePath)) return nodes.filter((n):n is DocFile=>n.type==='file')
      for(const n of nodes){
        if(n.type==='folder'){ const found=search(n.children); if(found) return found }
      }
      return null
    }
    return search(tree)??[]
  }

  // Helper: replace children of a folder node deep in the tree
  function injectChildren(tree:(DocFile|DocFolder)[], folderPath:string, children:(DocFile|DocFolder)[]): (DocFile|DocFolder)[] {
    return tree.map(n=>{
      if(n.type==='folder'){
        if(n.path===folderPath) return {...n,children}
        return {...n,children:injectChildren(n.children,folderPath,children)}
      }
      return n
    })
  }

  // Load doc tree — shallow top level, then re-load every folder that's expanded or
  // was previously loaded (recursively, any depth) in parallel. This is a "hard"
  // refresh: it picks up new/changed/removed files anywhere in the already-opened tree.
  const refreshDocs=useCallback((delayMs=0)=>{
    if(!api||!selectedClient) return
    const cp=rootPath.replace(/\\$/,'')+`\\${selectedClient}`
    setRefreshing(true)
    setTimeout(async ()=>{
      try{
        const topLevel=await api!.listDocs(cp)
        // Expand top-level folders that were previously expanded (or all on first load)
        let expanded=expandedFoldersRef.current
        if(expanded.size===0){
          expanded=new Set(topLevel.filter(n=>n.type==='folder').map(n=>n.path))
          setExpandedFolders(expanded)
        }
        setDocTree(topLevel)

        // Re-fetch top-level folders + every folder that was expanded/loaded before (any depth)
        const foldersToLoad=new Set<string>(topLevel.filter(n=>n.type==='folder').map(n=>n.path))
        for(const p of expanded) foldersToLoad.add(p)
        for(const p of loadedFolderPathsRef.current) foldersToLoad.add(p)

        const paths=[...foldersToLoad]
        if(paths.length>0){
          const loaded=await Promise.all(paths.map(p=>api!.listFolder(p).then(ch=>({path:p,ch})).catch(()=>({path:p,ch:[] as (DocFile|DocFolder)[]}))))
          setDocTree(prev=>{
            let t=[...prev]
            for(const {path:p,ch} of loaded) t=injectChildren(t,p,ch)
            return t
          })
          setLoadedFolderPaths(new Set(paths))
        }
      } finally {
        setRefreshing(false)
      }
    },delayMs)
  },[selectedClient,rootPath])

  useEffect(()=>{refreshDocs()},[refreshDocs])

  // Fit-to-page: compute zoom % so the page exactly fills the scroll viewport
  const fitToPage=useCallback(()=>{
    const el=pdfScrollRef.current
    if(!el||!pageSize.w||!pageSize.h) return
    const padding=48 // p-6 on each side (24px*2)
    const availW=el.clientWidth-padding
    const availH=el.clientHeight-padding
    const scaleW=(availW/pageSize.w)*100
    const scaleH=(availH/pageSize.h)*100
    const newZoom=Math.floor(Math.min(scaleW,scaleH))
    setZoom(Math.max(25,Math.min(400,newZoom)))
  },[pageSize])

  const handlePdfWheel=useCallback((_e:React.WheelEvent<HTMLDivElement>)=>{},[])


  // Load PDF + annotations when file selected
  useEffect(()=>{
    if(!api||!selectedFile) return
    // Use pending page from bookmark click, otherwise start at page 1
    const startPage = pendingPageRef.current ?? 1
    pendingPageRef.current = null
    setCurrentPage(startPage)
    pdfScrollRef.current?.scrollTo({top:0})
    setAnnotations({tickmarks:[],signoffs:[]})
    if(fileExt(selectedFile.name)==='txt'){
      setPdfBytes(null); setNoteText(null); setNoteLoaded(false)
      api.readTextFile(selectedFile.path).then(r=>{ setNoteText(r.ok?(r.content??''):''); setNoteLoaded(true) })
      return
    }
    setNoteText(null); setNoteLoaded(false)
    if(isImageFile(selectedFile.name)){ setPdfBytes(null); return }
    if(!isPdfFile(selectedFile.name)){ setPdfBytes(null); return }
    api.readPdf(selectedFile.path).then(setPdfBytes)
    api.getAnnotations(selectedFile.path).then(setAnnotations)
  },[selectedFile])

  // Load image as blob URL when an image file is selected
  useEffect(()=>{
    if(!selectedFile||!isImageFile(selectedFile.name)||!api){setImageUrl(null);return}
    let url:string|null=null
    api.readPdf(selectedFile.path).then(bytes=>{
      if(!bytes) return
      const ext=fileExt(selectedFile.name)
      const mime=ext==='png'?'image/png':ext==='gif'?'image/gif':'image/jpeg'
      url=URL.createObjectURL(new Blob([bytes],{type:mime}))
      setImageUrl(url)
    })
    return()=>{ if(url) URL.revokeObjectURL(url); setImageUrl(null) }
  },[selectedFile?.path])

  // Keep refreshDocsRef current so scan/event listeners always call the latest version
  useEffect(()=>{ refreshDocsRef.current=refreshDocs },[refreshDocs])

  const addTickmark=useCallback((partial:Omit<Tickmark,'id'|'author'|'createdAt'>)=>{
    const tm:Tickmark={...partial,id:crypto.randomUUID(),author,createdAt:new Date().toISOString()}
    setAnnotations(prev=>{
      const next={...prev,tickmarks:[...prev.tickmarks,tm]}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[author,selectedFile])

  const deleteTickmark=useCallback((id:string)=>{
    setAnnotations(prev=>{
      const next={...prev,tickmarks:prev.tickmarks.filter(t=>t.id!==id)}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  const moveTickmark=useCallback((id:string,x:number,y:number)=>{
    setAnnotations(prev=>{
      const next={...prev,tickmarks:prev.tickmarks.map(t=>t.id===id?{...t,x,y}:t)}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  const deleteSignoff=useCallback((page:number,role:string)=>{
    setAnnotations(prev=>{
      const next={...prev,signoffs:prev.signoffs.filter(s=>!(s.page===page&&s.role===role))}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  const addTapeStamp=useCallback((partial:Omit<TapeStamp,'id'|'author'|'createdAt'>)=>{
    const stamp:TapeStamp={...partial,id:crypto.randomUUID(),author,createdAt:new Date().toISOString()}
    setAnnotations(prev=>{
      const next={...prev,tapeStamps:[...(prev.tapeStamps??[]),stamp]}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[author,selectedFile])

  const deleteTapeStamp=useCallback((id:string)=>{
    setAnnotations(prev=>{
      const next={...prev,tapeStamps:(prev.tapeStamps??[]).filter(s=>s.id!==id)}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  const moveTapeStamp=useCallback((id:string,x:number,y:number)=>{
    setAnnotations(prev=>{
      const next={...prev,tapeStamps:(prev.tapeStamps??[]).map(s=>s.id===id?{...s,x,y}:s)}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  const addHighlight=useCallback((partial:Omit<Highlight,'id'|'author'|'createdAt'>)=>{
    const hl:Highlight={...partial,id:crypto.randomUUID(),author,createdAt:new Date().toISOString()}
    setAnnotations(prev=>{
      const next={...prev,highlights:[...(prev.highlights??[]),hl]}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[author,selectedFile])

  const deleteHighlight=useCallback((id:string)=>{
    setAnnotations(prev=>{
      const next={...prev,highlights:(prev.highlights??[]).filter(h=>h.id!==id)}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[selectedFile])

  // Keyboard shortcuts
  useEffect(()=>{
    function onKey(e:KeyboardEvent){
      if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement) return
      if(e.key==='ArrowRight'||e.key==='PageDown') setCurrentPage(p=>Math.min(pageCount,p+1))
      if(e.key==='ArrowLeft' ||e.key==='PageUp')   setCurrentPage(p=>Math.max(1,p-1))
      if((e.ctrlKey||e.metaKey)&&e.key==='c'&&selectedFile){
        setClipboard(selectedFile); e.preventDefault()
      }
      if((e.ctrlKey||e.metaKey)&&e.key==='v'&&clipboard&&api){
        e.preventDefault()
        api.copyFile(clipboard.path).then(r=>{ if(r.ok) refreshDocs(500); else alert('Copy failed: '+(r.error??'')) })
      }
    }
    window.addEventListener('keydown',onKey)
    return()=>window.removeEventListener('keydown',onKey)
  },[pageCount,selectedFile,clipboard,api,refreshDocs])

  // Register scan event listeners (once on mount) — use ref so closure always has latest refreshDocs
  useEffect(()=>{
    api?.onScanFile(({name,destFolder,appended})=>{
      setScanning(false); setScanPage(0)
      const id=crypto.randomUUID()
      setScanToasts(prev=>[...prev,{id,name:appended?`${name} (pages appended)`:name}])
      setTimeout(()=>setScanToasts(prev=>prev.filter(t=>t.id!==id)),5000)
      refreshDocsRef.current(300)
      const scannedPath=destFolder.replace(/[\\/]$/,'')+`\\${name}`
      setTimeout(()=>{
        setDocTree(prev=>{
          function findFile(nodes:(DocFile|DocFolder)[]): DocFile|null {
            for(const n of nodes){
              if(n.type==='file'&&n.path===scannedPath) return n
              if(n.type==='folder'){const f=findFile(n.children);if(f) return f}
            }
            return null
          }
          const f=findFile(prev)
          if(f){
            setSelectedFile(f)
            if(appended){
              api?.readPdf(f.path).then(b=>{ if(b) setPdfBytes(b) })
            } else {
              api?.getAnnotations(f.path).then(ann=>{
                const next={...ann,addedAt:new Date().toISOString(),addedBy:authorRef.current||null}
                api?.saveAnnotations(f.path,next)
              })
            }
          }
          return prev
        })
      },600)
    })
    api?.onScanError(err=>{ setScanning(false); setScanPage(0); alert('Scan error: '+err) })
    api?.onScanProgress(({page})=>setScanPage(page))
  },[])

  // Close context menus on click
  useEffect(()=>{
    const close=()=>{ setCtxMenu(null); setCtxFolder(null) }
    window.addEventListener('click',close)
    return()=>window.removeEventListener('click',close)
  },[])

  const pickFolder=async()=>{
    if(!api) return
    const p=await api.pickFolder()
    if(p) changeRootPath(p)
  }

  // Rename — preserves original extension
  async function handleRename(){
    if(!api||!renaming) return
    let newName=renaming.value.trim()
    if(!newName){setRenaming(null);return}
    const ext=renaming.file.name.match(/\.[^.]+$/)?.[0]??''
    if(ext&&!newName.toLowerCase().endsWith(ext.toLowerCase())) newName+=ext
    if(newName===renaming.file.name){setRenaming(null);return}
    const result=await api.renameFile(renaming.file.path,newName)
    if(result.ok){
      if(selectedFile?.path===renaming.file.path) setSelectedFile(null)
      setRenaming(null)
      refreshDocs(500)
    } else {
      alert(result.error??'Rename failed')
    }
  }

  // Bookmark expand/collapse
  async function handleToggleBookmarks(e:React.MouseEvent, filePath:string) {
    e.stopPropagation()
    // Collapse if open
    if (expandedBookmarks.has(filePath)) {
      setExpandedBookmarks(prev=>{const n=new Set(prev);n.delete(filePath);return n})
      return
    }
    // Already loaded — just expand
    const cached = fileBookmarks[filePath]
    if (cached && cached !== 'loading' && cached !== 'none') {
      setExpandedBookmarks(prev=>new Set([...prev,filePath]))
      return
    }
    if (cached === 'none' || cached === 'loading') return

    // Load PDF and extract outline
    setFileBookmarks(prev=>({...prev,[filePath]:'loading'}))
    try {
      const bytes = await api!.readPdf(filePath)
      if (!bytes) { setFileBookmarks(prev=>({...prev,[filePath]:'none'})); return }

      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString()
      const pdf = await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise
      const outline = await pdf.getOutline()

      if (!outline||outline.length===0) {
        setFileBookmarks(prev=>({...prev,[filePath]:'none'}))
        return
      }

      async function resolveItems(items:any[]): Promise<Bookmark[]> {
        return Promise.all(items.map(async item=>{
          let page:number|null=null
          try {
            let dest=item.dest
            if (typeof dest==='string') dest=await pdf.getDestination(dest)
            if (dest?.[0]) page=await pdf.getPageIndex(dest[0])+1
          } catch {}
          return {title:item.title||'(untitled)',page,items:item.items?.length?await resolveItems(item.items):[]}
        }))
      }

      const bookmarks=await resolveItems(outline)
      setFileBookmarks(prev=>({...prev,[filePath]:bookmarks}))
      setExpandedBookmarks(prev=>new Set([...prev,filePath]))
    } catch {
      setFileBookmarks(prev=>({...prev,[filePath]:'none'}))
    }
  }

  function handleBookmarkClick(file:DocFile, page:number) {
    if (selectedFile?.path === file.path) {
      setCurrentPage(page)
      pdfScrollRef.current?.scrollTo({top:0})
    } else {
      // Open the file then jump to the target page
      pendingPageRef.current = page
      setMultiSelect([])
      setSelectedFile(file)
    }
  }

  function renderBookmarks(bookmarks:Bookmark[], onPageClick:(page:number)=>void, depth=0):React.ReactNode {
    return bookmarks.map((bm,i)=>(
      <React.Fragment key={i}>
        <div
          className="flex items-center gap-1.5 cursor-pointer row-hover"
          style={{paddingLeft:8+depth*10,paddingTop:4,paddingBottom:4,paddingRight:8}}
          onClick={()=>{if(bm.page) onPageClick(bm.page)}}
        >
          <div style={{width:8,flexShrink:0}}>
            {bm.items.length>0&&<ChevronRight size={8} style={{color:C.inkFaint}}/>}
          </div>
          <span style={{fontSize:11,color:C.ochre,flexShrink:0}}>§</span>
          <span className="flex-1 truncate sans" style={{fontSize:12,color:C.inkSoft}}>{bm.title}</span>
          {bm.page&&<span className="mono flex-shrink-0" style={{fontSize:10,color:C.inkFaint,marginLeft:4}}>{bm.page}</span>}
        </div>
        {bm.items.length>0&&renderBookmarks(bm.items,onPageClick,depth+1)}
      </React.Fragment>
    ))
  }

  // Drag & drop — moves all Ctrl-selected files if drag source is among them
  async function handleDrop(destFolder:string){
    if(!api||!dragSrc) return
    const src=dragSrc; setDragOver(null); setDragSrc(null)
    const dragIsInSelection=multiSelect.some(f=>f.path===src)
    const filesToMove=dragIsInSelection&&multiSelect.length>1
      ? multiSelect.map(f=>f.path)
      : [src]
    const errors:string[]=[]
    const moved:string[]=[]
    for(const fp of filesToMove){
      const r=await api.moveFile(fp,destFolder)
      if(!r.ok) errors.push(r.error??fp)
      else moved.push(fp)
    }
    if(errors.length) alert(`Some files could not be moved:\n${errors.join('\n')}`)
    if(moved.length) setDocTree(prev=>removeFilesFromTree(prev,moved))
    if(filesToMove.includes(selectedFile?.path??'')) setSelectedFile(null)
    setMultiSelect([])
    refreshDocs(1500)
  }

  // Combine with file above
  const visible=visibleFiles(docTree,expandedFolders)
  const selIdx=selectedFile?visible.findIndex(f=>f.path===selectedFile.path):-1
  const fileAbove=selIdx>0?visible[selIdx-1]:null

  async function handlePrint(){
    if(!api||!selectedFile) return
    const r=await api.printFile(selectedFile.path)
    if(!r.ok) alert('Print failed: '+(r.error??''))
  }

  async function handlePrintPage(){
    if(!api||!selectedFile) return
    try{
      const fresh=await api.readPdf(selectedFile.path)
      if(!fresh) return
      const {PDFDocument}=await import('pdf-lib')
      const src=await PDFDocument.load(fresh)
      const doc=await PDFDocument.create()
      const [pg]=await doc.copyPages(src,[currentPage-1])
      doc.addPage(pg)
      const saved=await doc.save({useObjectStreams:false})
      const buf=saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength) as ArrayBuffer
      const r=await api.printBytes(buf.slice(0))
      if(!r.ok) alert('Print failed: '+(r.error??''))
    }catch(e){alert('Print failed: '+String(e))}
  }

  const [showMagicLinkSettings,setShowMagicLinkSettings]=useState(false)
  const [emailModal,setEmailModal]=useState<{items:EmailItem[];clientFiles:DocFile[]}|null>(null)
  const [uploadRequestModal,setUploadRequestModal]=useState<{folderPath:string;folderName:string}|null>(null)
  const [uploadInboxModal,setUploadInboxModal]=useState(false)
  type UploadRequest={label:string;folderPath:string;url:string;createdAt:string;expiresDays:number}
  const [uploadRequests,setUploadRequests]=useState<Record<string,UploadRequest>>({})
  const [uploadBadge,setUploadBadge]=useState(0)

  // Poll for pending uploads every 2 minutes while the app is open
  useEffect(()=>{
    async function poll(){
      const reqs=await api?.listUploadRequests()
      if(!reqs) return
      setUploadRequests(reqs)
      let pending=0
      for(const token of Object.keys(reqs)){
        const r=await api?.checkUploads(token)
        if(r?.ok&&r.files&&r.files.length>0) pending+=r.files.length
      }
      setUploadBadge(pending)
    }
    poll()
    const id=setInterval(poll,120000)
    return ()=>clearInterval(id)
  },[api])

  async function handleCheckForUpdates(){
    setUpdateStatus({message:'Checking for updates…',type:'info'})
    const r=await api?.checkForUpdates()
    if(!r) return
    setUpdateStatus({
      message: r.message,
      type: r.status==='available'||r.status==='latest'?'success':'error'
    })
    setTimeout(()=>setUpdateStatus(null), 6000)
  }

  async function emailCurrentFile(){
    if(!selectedFile) return
    setEmailModal({items:[{name:selectedFile.name,path:selectedFile.path}],clientFiles:flatFiles(docTree)})
  }

  async function emailCurrentPage(){
    if(!api||!selectedFile||!pdfBytes) return
    try{
      const {PDFDocument}=await import('pdf-lib')
      const fresh=await api.readPdf(selectedFile.path)
      if(!fresh) return
      const src=await PDFDocument.load(fresh)
      const doc=await PDFDocument.create()
      const [pg]=await doc.copyPages(src,[currentPage-1])
      doc.addPage(pg)
      const saved=await doc.save({useObjectStreams:false})
      const buf=(saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength) as ArrayBuffer).slice(0)
      const name=selectedFile.name.replace(/\.[^.]+$/,'')+`_p${currentPage}.pdf`
      setEmailModal({items:[{name,bytes:buf}],clientFiles:flatFiles(docTree)})
    }catch(e){ alert('Could not prepare page for email: '+String(e)) }
  }

  const [rotating,setRotating]=useState(false)
  async function handleRotatePage(){
    if(!api||!selectedFile||!pdfBytes||rotating) return
    setRotating(true)
    try{
      const {PDFDocument,degrees}=await import('pdf-lib')
      // pdfBytes may have been transferred (detached) to the pdf.js worker,
      // so re-read fresh bytes from disk before editing
      const fresh=await api.readPdf(selectedFile.path)
      if(!fresh){ alert('Could not read PDF for rotation.'); return }
      const doc=await PDFDocument.load(fresh)
      const page=doc.getPage(currentPage-1)
      const current=page.getRotation().angle
      page.setRotation(degrees((current+90)%360))
      const saved=await doc.save({useObjectStreams:false})
      const buf=saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength) as ArrayBuffer
      const r=await api.savePdf(selectedFile.path,buf)
      if(!r.ok){ alert('Could not save rotation: '+(r.error??'Unknown error')); return }
      setPdfBytes(buf)
    }catch(e){
      alert('Rotate failed: '+String(e))
    }finally{
      setRotating(false)
    }
  }

  const [combining,setCombining]=useState(false)
  async function handleCombine(){
    if(!api||!selectedFile||!fileAbove) return
    const ok=window.confirm(`Combine:\n  ${fileAbove.name}\n+ ${selectedFile.name}\n\nThe top file will contain both documents. The bottom file will be deleted.`)
    if(!ok) return
    setCombining(true)
    try{
      const result=await api.combineFiles(fileAbove.path,selectedFile.path)
      if(result.ok){
        setSelectedFile(null); setPdfBytes(null)
        refreshDocs(500)
      } else {
        alert(result.error??'Combine failed')
      }
    }finally{
      setCombining(false)
    }
  }

  const toggleSignoff=()=>{
    setAnnotations(prev=>{
      const exists=prev.signoffs.some(s=>s.page===currentPage&&s.role==='Reviewer')
      const next=exists
        ?{...prev,signoffs:prev.signoffs.filter(s=>!(s.page===currentPage&&s.role==='Reviewer'))}
        :{...prev,signoffs:[...prev.signoffs,{page:currentPage,role:'Reviewer',author,signedAt:new Date().toISOString()}]}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  }

  const isSignedOff=annotations.signoffs.some(s=>s.page===currentPage&&s.role==='Reviewer')

  const filteredClients=clients.filter(c=>c.toLowerCase().includes(search.toLowerCase()))

  async function toggleFolder(p:string){
    setExpandedFolders(prev=>{const n=new Set(prev);n.has(p)?n.delete(p):n.add(p);return n})
    // Lazy-load children the first time a folder is expanded
    if(!loadedFolderPaths.has(p) && api){
      const children=await api.listFolder(p)
      setDocTree(prev=>injectChildren(prev,p,children))
      setLoadedFolderPaths(prev=>{const n=new Set(prev);n.add(p);return n})
    }
  }

  function handleNoteChange(value:string){
    setNoteText(value)
    if(!selectedFile||!api) return
    const path=selectedFile.path
    if(noteSaveTimer.current) clearTimeout(noteSaveTimer.current)
    noteSaveTimer.current=setTimeout(()=>{
      setNoteSaving(true)
      api.writeTextFile(path,value).finally(()=>setNoteSaving(false))
    },600)
  }

  async function extractClientInfo(bytes:ArrayBuffer):Promise<{idMatch?:string;idLabel:string;spouseSsn?:string;nameValue?:string}>{
      const pdfjsLib=await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString()
      const pdf=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise

      const ssnRe=/\b\d{3}-\d{2}-\d{4}\b|\*{3}-\*{2}-\d{4}/
      const ssnReAll=/\b\d{3}-\d{2}-\d{4}\b|\*{3}-\*{2}-\d{4}/g
      const einRe=/\b\d{2}-\d{7}\b|\*{2}-\*{3}\d{4}/
      let idMatch:string|undefined
      let idLabel='EIN'
      let spouseSsn:string|undefined
      let nameValue:string|undefined

      const maxPages=Math.min(pdf.numPages,12)
      for(let p=1;p<=maxPages;p++){
        const page=await pdf.getPage(p)
        const content=await page.getTextContent()
        const items=content.items as {str:string;transform:number[]}[]

        // group text items into lines by y-position
        const lines:{y:number;items:{x:number;str:string}[]}[]=[]
        for(const it of items){
          const str=it.str
          if(!str.trim()) continue
          const y=Math.round(it.transform[5])
          const x=it.transform[4]
          let line=lines.find(l=>Math.abs(l.y-y)<3)
          if(!line){ line={y,items:[]}; lines.push(line) }
          line.items.push({x,str})
        }
        lines.forEach(l=>l.items.sort((a,b)=>a.x-b.x))
        lines.sort((a,b)=>b.y-a.y) // top of page first

        const fullText=lines.map(l=>l.items.map(i=>i.str).join(' ')).join('\n')
        const ssnMatches=[...new Set([...fullText.matchAll(ssnReAll)].map(m=>m[0]))]
        const einMatch=fullText.match(einRe)
        if(ssnMatches.length===0&&!einMatch) continue

        // business returns (1120/1120-S/1065/990) use an EIN, not an SSN —
        // even if a stray \d{3}-\d{2}-\d{4}-shaped number (e.g. a date or
        // PTIN) appears on the page, prefer the EIN for these forms
        const isBusinessForm=/\b(1120-?s?|1065|990)\b/i.test(fullText)

        let idStr:string
        if(ssnMatches.length>0&&!(isBusinessForm&&einMatch)){
          idStr=ssnMatches[0]
          idLabel='Primary SSN'
          idMatch=ssnMatches[0]
          if(ssnMatches.length>1) spouseSsn=ssnMatches[1]
        }else{
          idStr=einMatch![0]
          idLabel='EIN'
          idMatch=einMatch![0]
        }

        const idLine=lines.find(l=>l.items.some(i=>i.str.includes(idStr)))
        if(idLine){
          const idItem=idLine.items.find(i=>i.str.includes(idStr))!
          // try to find a "name" label on a nearby line above, and read the
          // value aligned under it on the id line (works well for 1065/1120)
          const labelLine=lines.find(l=>l.y>idLine.y&&l.y-idLine.y<=40&&l.items.some(i=>/name/i.test(i.str)))
          if(labelLine){
            const labelItem=labelLine.items.find(i=>/name/i.test(i.str))!
            const candidates=idLine.items
              .filter(i=>i.x>=labelItem.x-15&&i.x<idItem.x-5)
              .map(i=>i.str.trim()).filter(Boolean)
            const candidate=candidates.join(' ').trim()
            if(candidate) nameValue=candidate
          }
          if(!nameValue){
            const others=idLine.items.filter(i=>!i.str.includes(idStr)).map(i=>i.str.trim()).filter(Boolean)
              .filter(s=>!/^ph:?/i.test(s)&&!/^[a-z]{2,}\d{3,}$/i.test(s)&&!/^\d/.test(s))
            nameValue=others.join(' ').trim()||undefined
          }
        }
        if(!nameValue){
          nameValue=lines.slice(0,15)
            .map(l=>l.items.map(i=>i.str.trim()).filter(Boolean)
              .filter(s=>!/^ph:?/i.test(s)&&!/^[a-z]{2,}\d{3,}$/i.test(s)&&!/^\d{4}$/.test(s))
              .join(' ').trim())
            .find(s=>s.length>3&&!/form|department|treasury|internal revenue|omb|for the year|filing status|^\(/i.test(s))
        }
        if(nameValue){
          // strip a leading client-code token (e.g. "REST7529 ") and a
          // trailing standalone year (e.g. " 2025") that sometimes share
          // the same text item as the actual name
          nameValue=nameValue.replace(/^[A-Za-z]{2,8}\d{2,6}\s+/,'').replace(/\s+\d{4}$/,'').trim()||undefined
        }
        break
      }

      return {idMatch,idLabel,spouseSsn,nameValue}
  }

  async function openClientInfo(name:string){
    if(!api) return
    setClientInfo({loading:true})
    const clientPath=rootPath.replace(/\\$/,'')+`\\${name}`
    const found=await api.findTaxForms(clientPath)
    if(!found?.ok||!found.results||found.results.length===0){ setClientInfo({loading:false,error:'No 1040, 1120, 1065, or 990 found for this client.'}); return }

    let fallback:{info:{idMatch?:string;idLabel:string;spouseSsn?:string;nameValue?:string};formName:string}|undefined
    try{
      for(const candidate of found.results){
        const bytes=await api.readPdf(candidate.path)
        if(!bytes) continue
        const info=await extractClientInfo(bytes)
        if(!info.idMatch) continue
        const isMasked=info.idMatch.includes('*')||(!!info.spouseSsn&&info.spouseSsn.includes('*'))
        if(!isMasked){
          setClientInfo({loading:false,name:info.nameValue,idLabel:info.idLabel,idValue:info.idMatch,spouseSsn:info.spouseSsn,formName:candidate.name})
          return
        }
        if(!fallback) fallback={info,formName:candidate.name}
      }
      if(fallback){
        setClientInfo({loading:false,name:fallback.info.nameValue,idLabel:fallback.info.idLabel,idValue:fallback.info.idMatch,spouseSsn:fallback.info.spouseSsn,formName:fallback.formName})
      }else{
        setClientInfo({loading:false,error:'Could not find a Name or SSN/EIN on any tax return for this client.'})
      }
    }catch(e:unknown){
      setClientInfo({loading:false,error:'Could not extract data: '+String(e)})
    }
  }

  function renderTree(nodes:(DocFile|DocFolder)[],depth=0):React.ReactNode{
    return nodes.map(node=>{
      if(node.type==='folder'){
        const open=expandedFolders.has(node.path)
        const isDrop=dragOver===node.path
        return(
          <div key={node.path}>
            <div
              className="flex items-center gap-1.5 cursor-pointer"
              style={{paddingLeft:10+depth*14,paddingTop:6,paddingBottom:6,paddingRight:8,color:isDrop?C.ochreDeep:C.inkMuted,backgroundColor:isDrop?'#F2DFA8':'transparent',borderLeft:isDrop?`4px solid ${C.ochre}`:'4px solid transparent',borderRadius:2,transition:'background-color 0.1s'}}
              onClick={()=>{toggleFolder(node.path);setActiveFolder({name:node.name,path:node.path})}}
              onContextMenu={e=>{e.preventDefault();e.stopPropagation();setCtxFolder({x:e.clientX,y:e.clientY,folder:node})}}
              onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(node.path)}}
              onDragLeave={e=>{e.stopPropagation();setDragOver(null)}}
              onDrop={e=>{e.preventDefault();e.stopPropagation();handleDrop(node.path)}}
            >
              <span style={{fontSize:15,fontWeight:700,color:C.inkMuted,width:14,display:'inline-block',textAlign:'center',lineHeight:1,flexShrink:0}}>{open?'−':'+'}</span>
              {open?<FolderOpen size={14} style={{color:isDrop?C.ochreDeep:C.ochre,flexShrink:0}}/>:<FolderClosed size={14} style={{color:isDrop?C.ochreDeep:C.ochre,flexShrink:0}}/>}
              <span className="serif" title={node.name} style={{fontSize:14,fontWeight:600,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{node.name}</span>
            </div>
            {open&&renderTree(node.children,depth+1)}
          </div>
        )
      }

      const isActive=selectedFile?.path===node.path
      const isDragging=dragSrc===node.path
      const isMulti=multiSelect.some(f=>f.path===node.path)
      const isAbove=fileAbove?.path===node.path
      const bmState=fileBookmarks[node.path]
      const bmOpen=expandedBookmarks.has(node.path)
      const hasBm=bmState&&bmState!=='loading'&&bmState!=='none'
      const showExpandBtn=bmState!=='none' // hide button once we confirm no bookmarks

      return(
        <React.Fragment key={node.path}>
          <div
            draggable
            onDragStart={e=>{
              e.dataTransfer.effectAllowed='move'
              if(!multiSelect.some(f=>f.path===node.path)) setMultiSelect([])
              setDragSrc(node.path)
            }}
            onDragEnd={()=>setDragSrc(null)}
            className="flex items-center gap-1 cursor-pointer relative"
            style={{
              paddingLeft:6+depth*14,paddingRight:10,paddingTop:5,paddingBottom:5,
              backgroundColor:isActive?C.ochreSoft:isMulti?'#E8F0F8':'transparent',
              opacity:isDragging?0.35:1,
              borderLeft:isActive?`4px solid ${C.ochre}`:isMulti?`4px solid #4A7FA5`:isAbove?`4px solid ${C.ochreLight}`:'4px solid transparent',
            }}
            onClick={e=>{
              if(e.ctrlKey||e.metaKey){
                setMultiSelect(prev=>prev.some(f=>f.path===node.path)?prev.filter(f=>f.path!==node.path):[...prev,node])
              } else {
                setMultiSelect([]); setSelectedFile(node)
                if(needsExternalApp(node.name)) api?.openFile(node.path)
              }
            }}
            onContextMenu={e=>{
              e.preventDefault();e.stopPropagation()
              if(!multiSelect.some(f=>f.path===node.path)) setMultiSelect([])
              setCtxMenu({x:e.clientX,y:e.clientY,file:node})
            }}
          >
            {/* Bookmark expand button */}
            {showExpandBtn ? (
              <button
                onClick={e=>handleToggleBookmarks(e,node.path)}
                title="Show bookmarks"
                style={{width:16,height:16,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,color:hasBm?C.ochre:C.inkFaint,cursor:'pointer'}}
              >
                {bmState==='loading'
                  ? <span style={{fontSize:9}}>…</span>
                  : <span style={{fontSize:13,fontWeight:700,lineHeight:1}}>{bmOpen?'−':'+'}</span>
                }
              </button>
            ) : (
              <span style={{width:16,flexShrink:0}}/>
            )}
            {isWordFile(node.name)?(
              <FileText size={13} style={{color:isActive?C.ochre:'#2C5F9E',flexShrink:0}}/>
            ):isExcelFile(node.name)?(
              <FileSpreadsheet size={13} style={{color:isActive?C.ochre:'#2E7D4F',flexShrink:0}}/>
            ):fileExt(node.name)==='txt'?(
              <StickyNote size={13} style={{color:isActive?C.ochre:'#B8870A',flexShrink:0}}/>
            ):(
              <FileText size={13} style={{color:isActive?C.ochre:C.inkFaint,flexShrink:0}}/>
            )}
            <span className="flex-1 truncate sans" title={node.name} style={{fontSize:14,color:isActive?C.ink:C.inkSoft,fontWeight:isActive?600:400,marginLeft:3}}>{node.name}</span>
            {node.annotations.tickmarks.length>0&&(
              <span className="mono px-1 rounded flex-shrink-0" style={{backgroundColor:isActive?C.ochre:C.paperDeep,color:isActive?C.paperLight:C.inkSoft,fontSize:10,fontWeight:600}}>
                {node.annotations.tickmarks.length}
              </span>
            )}
          </div>
          {/* Bookmark tree */}
          {bmOpen&&Array.isArray(bmState)&&(
            <div style={{borderLeft:`2px solid ${C.ochreLight}`,marginLeft:6,marginRight:0}}>
              {renderBookmarks(bmState, (page)=>handleBookmarkClick(node,page))}
            </div>
          )}
        </React.Fragment>
      )
    })
  }

  return(
    <div className="h-screen w-full flex flex-col overflow-hidden" style={{backgroundColor:C.paper,fontFamily:'"Inter",-apple-system,sans-serif',color:C.ink,fontSize:12}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .serif{font-family:'Fraunces',Georgia,serif}
        .mono{font-family:'JetBrains Mono','SF Mono',monospace}
        .sans{font-family:'Inter',sans-serif}
        .scrollbar-thin::-webkit-scrollbar{width:5px}
        .scrollbar-thin::-webkit-scrollbar-track{background:transparent}
        .scrollbar-thin::-webkit-scrollbar-thumb{background:${C.rule};border-radius:3px}
        .row-hover:hover{background-color:rgba(168,119,31,0.07)!important}
        @keyframes shimmer{0%,100%{opacity:1}50%{opacity:0.5}}
        .pulse{animation:shimmer 2s ease-in-out infinite}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .spin{animation:spin 0.7s linear infinite}
        .doc-shadow{box-shadow:0 1px 2px rgba(26,22,18,0.04),0 4px 12px rgba(26,22,18,0.06),0 16px 40px rgba(26,22,18,0.08)}
        .tool-btn{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid transparent;transition:all 0.12s}
        .tool-btn:hover{background:rgba(168,119,31,0.08);border-color:${C.ruleSoft}}
        .tool-btn:disabled{opacity:0.35;cursor:not-allowed}
        .drag-region{-webkit-app-region:drag}
        .no-drag{-webkit-app-region:no-drag}
      `}</style>

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-4 py-2 flex-shrink-0 drag-region" style={{backgroundColor:C.ink,color:C.paperLight}}>
        <div className="flex items-center gap-3 min-w-0 no-drag">
          <div className="flex items-center gap-2.5">
            <div style={{width:26,height:26,backgroundColor:C.ochre,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:2}}>
              <span className="serif" style={{fontSize:16,fontWeight:700,color:C.ink,lineHeight:1}}>B</span>
            </div>
            <div>
              <div className="serif" style={{fontSize:14,fontWeight:600,letterSpacing:-0.2,lineHeight:1.1}}>Workpapers</div>
              <div className="sans" style={{fontSize:9,color:C.inkFaint,letterSpacing:0.6,textTransform:'uppercase',marginTop:1}}>Bellomy Accounting</div>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 ml-4 pl-4" style={{borderLeft:`1px solid ${C.inkSoft}`}}>
            <Layers size={11} style={{color:C.inkFaint}}/>
            <div className="mono" style={{fontSize:10,color:C.inkFaint}}>
              <span style={{color:C.ochreLight}}>{rootPath.replace(/\\$/,'')}</span>
              {selectedClient&&`\\${selectedClient}`}
              {selectedFile&&`\\${selectedFile.name}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] flex-shrink-0 no-drag">
          <div className="flex items-center gap-1.5">
            <div className="pulse" style={{width:6,height:6,borderRadius:'50%',backgroundColor:'#7DBE5C'}}/>
            <span style={{color:C.inkFaint}}>Synced</span>
          </div>
          <div style={{height:14,width:1,backgroundColor:C.inkSoft}}/>
          <button onClick={pickFolder} style={{color:C.inkFaint}} title="Change root folder"><Settings size={11}/></button>
          <div onClick={()=>setShowNamePrompt(true)} title={`${author} (click to change)`} style={{width:18,height:18,backgroundColor:C.ochre,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,color:C.ink,cursor:'pointer'}}>{initials(author)}</div>
          <div style={{width:1,height:14,backgroundColor:C.inkSoft}}/>
          <button onClick={()=>api?.minimizeWindow()} title="Minimize" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:C.inkFaint}} className="row-hover">─</button>
          <button onClick={()=>api?.maximizeWindow()} title="Maximize" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:C.inkFaint}} className="row-hover">□</button>
          <button onClick={()=>api?.closeWindow()} title="Close" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:'#B5443A',fontWeight:700}} className="row-hover">✕</button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">

        {/* ── Left rail ── */}
        {leftOpen?(
          <div className="flex flex-col flex-shrink-0" style={{width:leftWidth,backgroundColor:C.paperLight,borderRight:`1px solid ${C.rule}`}}>
            <div className="px-3 py-2 flex items-center gap-1.5" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
              <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded" style={{backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>
                <Search size={11} style={{color:C.inkMuted,flexShrink:0}}/>
                <input
                  ref={clientSearchRef}
                  type="text"
                  placeholder="Search clients…"
                  value={selectedClient&&!search ? selectedClient : search}
                  onFocus={()=>{
                    if(selectedClient){
                      setSearch('')
                      setSelectedClient(null);setSelectedFile(null);setDocTree([]);setExpandedFolders(new Set());setLoadedFolderPaths(new Set());setActiveFolder(null)
                    }
                  }}
                  onChange={e=>setSearch(e.target.value)}
                  className="flex-1 outline-none text-[11px] bg-transparent min-w-0 sans"
                  style={{color:C.ink,fontWeight:selectedClient&&!search?600:400}}
                />
              </div>
              <button onClick={()=>setLeftOpen(false)} className="p-1 row-hover rounded" style={{color:C.inkMuted,flexShrink:0}}><PanelLeftClose size={13}/></button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {!selectedClient?(
                <>
                  <div className="px-3 py-2 flex items-center justify-between" style={{borderBottom:`1px solid ${C.ruleSoft}`}}
                    onContextMenu={e=>{
                      e.preventDefault();e.stopPropagation()
                      setCtxFolder({x:e.clientX,y:e.clientY,folder:{name:'Cabinet (entire client list)',type:'folder',path:rootPath.replace(/\\$/,''),children:[]},hoistOnly:true})
                    }}
                  >
                    <div className="serif" style={{fontSize:10,letterSpacing:1.2,textTransform:'uppercase',color:C.inkMuted,fontWeight:600}}>Clients</div>
                    <div className="mono" style={{fontSize:9,color:C.inkFaint}}>{clients.length}</div>
                  </div>
                  {!api&&<div className="px-3 py-4 text-center" style={{color:C.inkMuted,fontSize:10}}>Running in browser — no filesystem access.<br/>Launch as Electron app to browse Z:\</div>}
                  {filteredClients.map(name=>{
                    const isSel=selectedClient===name
                    return(
                      <div key={name} className="flex items-center gap-2 px-3 py-2 cursor-pointer relative row-hover" style={{backgroundColor:isSel?C.ochreSoft:'transparent'}} onClick={()=>{setSelectedClient(name);setSearch('');setActiveFolder({name,path:rootPath.replace(/\\$/,'')+`\\${name}`})}}
                        onContextMenu={e=>{
                          e.preventDefault();e.stopPropagation()
                          setCtxFolder({x:e.clientX,y:e.clientY,folder:{name,type:'folder',path:rootPath.replace(/\\$/,'')+`\\${name}`,children:[]},hoistOnly:true})
                        }}
                      >
                        {isSel&&<div className="absolute left-0 top-0 bottom-0" style={{width:2,backgroundColor:C.ochre}}/>}
                        <div style={{width:22,height:22,backgroundColor:isSel?C.ochre:C.paper,border:`1px solid ${isSel?C.ochre:C.rule}`,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          <span className="serif" style={{fontSize:11,fontWeight:600,color:isSel?C.ink:C.inkSoft}}>{name[0].toUpperCase()}</span>
                        </div>
                        <span className="flex-1 truncate sans" title={name} style={{fontSize:14,fontWeight:isSel?600:500,color:C.ink}}>{name}</span>
                        <button
                          title="Client info (name & SSN/EIN from tax return)"
                          onClick={e=>{e.preventDefault();e.stopPropagation();openClientInfo(name)}}
                          className="p-1 rounded row-hover flex-shrink-0"
                          style={{color:isSel?C.ochreDeep:C.inkFaint,display:'flex',alignItems:'center'}}
                        >
                          <CreditCard size={14}/>
                        </button>
                      </div>
                    )
                  })}
                </>
              ):(
                <>
                  <div className="px-3 py-1.5 flex items-center justify-between" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
                    <span className="serif" style={{fontSize:9,letterSpacing:1,textTransform:'uppercase',color:C.inkMuted,fontWeight:600}}>Documents</span>
                    <div className="flex items-center gap-1.5">
                      {multiSelect.length>1&&(
                        <span className="sans" style={{fontSize:9,color:'#4A7FA5',fontWeight:600,backgroundColor:'#E8F0F8',padding:'1px 5px',borderRadius:3}}>
                          {multiSelect.length} selected
                        </span>
                      )}
                      <span className="mono" style={{fontSize:9,color:C.inkFaint}}>{flatFiles(docTree).length}</span>
                      <button
                        onClick={async()=>{
                          const target=activeFolder
                          if(!target) return
                          const r=await api?.createNotesFile(target.path)
                          if(!r?.ok) alert('Could not create notes file: '+(r?.error??'Unknown error'))
                          else{
                            refreshDocs(500)
                            if(r.openError) alert('Notes file created but could not be opened automatically: '+r.openError)
                          }
                        }}
                        disabled={!activeFolder}
                        title={activeFolder?`Add notes file to "${activeFolder.name}"`:'Select a folder first'}
                        className="p-1 rounded row-hover"
                        style={{color:activeFolder?C.inkMuted:'#ccc',display:'flex',alignItems:'center'}}
                      >
                        <StickyNote size={16}/>
                      </button>
                      <button onClick={()=>refreshDocs()} disabled={refreshing} title="Refresh folder" className="p-1 rounded row-hover" style={{color:C.inkFaint,display:'flex',alignItems:'center'}}>
                        <RefreshCw size={20} className={refreshing?'spin':''}/>
                      </button>
                    </div>
                  </div>
                  <div className="py-1">{renderTree(docTree)}</div>
                </>
              )}
            </div>

            <div className="px-3 py-2 flex items-center justify-between" style={{borderTop:`1px solid ${C.ruleSoft}`,backgroundColor:C.paper}}>
              <div className="flex items-center gap-1.5">
                <div className="pulse" style={{width:5,height:5,borderRadius:'50%',backgroundColor:'#7DBE5C'}}/>
                <span className="mono" style={{fontSize:9,color:C.inkMuted}}>{rootPath}</span>
              </div>
              <div className="flex items-center gap-1">
                {['T:\\','Z:\\'].map(drive=>(
                  <button key={drive} onClick={()=>changeRootPath(drive)}
                    className="mono"
                    style={{fontSize:9,padding:'1px 5px',borderRadius:3,border:`1px solid ${rootPath===drive?C.ochre:C.rule}`,backgroundColor:rootPath===drive?C.ochreSoft:'transparent',color:rootPath===drive?C.ochreDeep:C.inkFaint,fontWeight:rootPath===drive?700:400,cursor:'pointer'}}
                    title={`Switch to ${drive}`}
                  >{drive.replace('\\','')}</button>
                ))}
              </div>
            </div>
          </div>
        ):(
          <button onClick={()=>setLeftOpen(true)} className="px-2 flex items-center row-hover" style={{backgroundColor:C.paperLight,borderRight:`1px solid ${C.rule}`,color:C.inkMuted}}><PanelLeftOpen size={14}/></button>
        )}

        {/* ── Left panel resize divider ── */}
        {leftOpen&&(
          <div
            onMouseDown={startResizeLeft}
            title="Drag to resize"
            style={{width:5,marginLeft:-2.5,marginRight:-2.5,zIndex:10,cursor:'col-resize',backgroundColor:resizingLeft?C.ochre:'transparent',flexShrink:0}}
          />
        )}

        {/* ── Main viewer ── */}
        <div className="flex-1 flex flex-col min-w-0" style={{backgroundColor:C.paper}}>

          {/* Doc header */}
          <div className="flex items-center justify-between px-4 py-2.5 flex-shrink-0" style={{backgroundColor:C.paperLight,borderBottom:`1px solid ${C.rule}`}}>
            <div className="min-w-0 flex-1">
              <span className="serif" style={{fontSize:14,fontWeight:600,letterSpacing:-0.3,color:C.ink}}>
                {selectedFile?.name??'No document open'}
              </span>
              <div className="flex items-center gap-2 mt-0.5" style={{fontSize:9,color:C.inkMuted}}>
                <span className="mono">Pg {currentPage} / {pageCount}</span>
                <span style={{color:C.inkFaint}}>·</span>
                <span>{annotations.tickmarks.length} tickmarks</span>
                {selectedFile&&<><span style={{color:C.inkFaint}}>·</span><Clock size={9}/><span>open</span></>}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={toggleSignoff} className="flex items-center gap-1.5 px-3 py-1.5 rounded sans" style={{fontSize:10,backgroundColor:isSignedOff?'#5C8A3A':C.ink,color:C.paperLight,fontWeight:600,letterSpacing:0.3}}>
                {isSignedOff?<Check size={11} strokeWidth={3}/>:<FileSignature size={11}/>}
                <span>{isSignedOff?'Reviewed':'Sign off'}</span>
              </button>
              {!rightOpen&&<button onClick={()=>setRightOpen(true)} className="p-1 ml-1" style={{color:C.inkMuted}}><PanelRightOpen size={13}/></button>}
            </div>
          </div>

          {/* ── Function bar ── */}
          <div className="flex items-center gap-1 px-3 py-1.5 flex-shrink-0" style={{backgroundColor:C.paperDeep,borderBottom:`1px solid ${C.rule}`}}>
            {/* Scan */}
            <button className="tool-btn sans" style={{color:C.inkSoft,opacity:scanning?0.5:1}} onClick={()=>{ if(!scanning) setShowScanModal(true) }} title="Scan document">
              <ScanLine size={14} style={{color:C.ochre}}/> Scan
            </button>
            {scanning&&(
              <span className="sans pulse" style={{fontSize:11,color:C.ochre}}>
                {scanPage>0?`Scanning p.${scanPage}…`:'Scanning…'}
              </span>
            )}
            <button className="tool-btn sans" style={{color:C.inkFaint,padding:'5px 6px'}} onClick={()=>setShowScanSettings(true)} title="Scanner settings">
              <Settings size={12}/>
            </button>

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Print full doc */}
            <button className="tool-btn" onClick={handlePrint} disabled={!selectedFile} title="Print document" style={{color:C.inkSoft,padding:'5px 8px'}}>
              <Printer size={14} style={{color:selectedFile?C.ochre:'#bbb'}}/>
            </button>
            {/* Print current page */}
            <button className="tool-btn" onClick={handlePrintPage} disabled={!selectedFile||!pdfBytes} title="Print current page" style={{color:C.inkSoft,padding:'5px 8px',position:'relative'}}>
              <Printer size={14} style={{color:selectedFile?C.ochre:'#bbb'}}/>
              <span style={{position:'absolute',top:3,right:3,fontSize:8,fontWeight:700,color:C.ochreDeep,lineHeight:1,backgroundColor:C.ochreSoft,borderRadius:2,padding:'0 1px'}}>1</span>
            </button>

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Email current file (magic link) */}
            <button className="tool-btn" onClick={emailCurrentFile} disabled={!selectedFile} title="Email this file (magic link)" style={{color:C.inkSoft,padding:'5px 8px'}}>
              <Mail size={14} style={{color:selectedFile?C.ochre:'#bbb'}}/>
            </button>
            {/* Email current page only */}
            <button className="tool-btn" onClick={emailCurrentPage} disabled={!selectedFile||!pdfBytes} title="Email current page only (magic link)" style={{color:C.inkSoft,padding:'5px 8px',position:'relative'}}>
              <Mail size={14} style={{color:selectedFile?C.ochre:'#bbb'}}/>
              <span style={{position:'absolute',top:3,right:3,fontSize:8,fontWeight:700,color:C.ochreDeep,lineHeight:1,backgroundColor:C.ochreSoft,borderRadius:2,padding:'0 1px'}}>1</span>
            </button>
            <button className="tool-btn" onClick={()=>setShowMagicLinkSettings(true)} title="Magic link settings" style={{color:C.inkFaint,padding:'5px 6px'}}>
              <Settings size={12}/>
            </button>
            {/* Upload request inbox */}
            <button className="tool-btn" onClick={()=>setUploadInboxModal(true)} title="Client upload inbox" style={{color:C.inkFaint,padding:'5px 6px',position:'relative'}}>
              <Inbox size={13} style={{color:uploadBadge>0?C.ochre:C.inkFaint}}/>
              {uploadBadge>0&&<span style={{position:'absolute',top:2,right:2,fontSize:8,fontWeight:700,color:'#fff',lineHeight:'12px',backgroundColor:'#B5443A',borderRadius:6,padding:'0 3px',minWidth:12,textAlign:'center'}}>{uploadBadge}</span>}
            </button>

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Combine with file above */}
            <button
              className="tool-btn sans"
              style={{color:fileAbove&&!combining?C.inkSoft:'#bbb'}}
              disabled={!fileAbove||combining}
              onClick={handleCombine}
              title={fileAbove?`Combine with: ${fileAbove.name}`:'Select a file to enable'}
            >
              <Merge size={14} style={{color:fileAbove&&!combining?C.ochre:'#bbb'}}/>
              {combining?'Combining…':'Combine with Above'}
            </button>

            <div className="flex-1"/>

            {/* Page nav */}
            <button onClick={()=>setCurrentPage(p=>Math.max(1,p-1))} className="tool-btn" style={{color:C.inkSoft,padding:'5px 6px'}}>‹</button>
            <span className="mono" style={{fontSize:11,color:C.inkSoft,minWidth:56,textAlign:'center'}}>pg {currentPage}/{pageCount}</span>
            <button onClick={()=>setCurrentPage(p=>Math.min(pageCount,p+1))} className="tool-btn" style={{color:C.inkSoft,padding:'5px 6px'}}>›</button>

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Zoom */}
            <button onClick={()=>setZoom(z=>Math.max(50,z-25))} className="tool-btn" style={{color:C.inkSoft,padding:'5px 6px'}}><ZoomOut size={13}/></button>
            <span className="mono" style={{fontSize:11,color:C.ink,fontWeight:600,minWidth:36,textAlign:'center'}}>{zoom}%</span>
            <button onClick={()=>setZoom(z=>Math.min(200,z+25))} className="tool-btn" style={{color:C.inkSoft,padding:'5px 6px'}}><ZoomIn size={13}/></button>
            <button onClick={fitToPage} title="Fit to page" className="tool-btn" style={{color:C.inkSoft,padding:'5px 6px'}}><Maximize2 size={13}/></button>
            <button onClick={handleRotatePage} disabled={!pdfBytes||rotating} title="Rotate this page 90° and save" className="tool-btn" style={{color:pdfBytes?C.inkSoft:'#bbb',padding:'5px 6px'}}><RotateCw size={13}/></button>

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Tape toggle */}
            <button onClick={()=>setShowCalculator(s=>!s)} className="tool-btn sans" style={{color:showCalculator?C.ochreDeep:C.inkSoft,backgroundColor:showCalculator?C.ochreSoft:'transparent',border:`1px solid ${showCalculator?C.ochreLight:'transparent'}`}}>
              🧮 Tape
            </button>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* PDF area */}
            <div className="relative flex-1 overflow-hidden">
              <div ref={pdfScrollRef} onWheel={handlePdfWheel} className="h-full overflow-auto p-6 scrollbar-thin" style={{backgroundColor:C.paperDeep}}>
                {selectedFile&&fileExt(selectedFile.name)==='txt'?(
                  <div className="mx-auto flex flex-col" style={{maxWidth:680,height:'100%',gap:8}}>
                    <div className="flex items-center justify-between">
                      <div className="serif flex items-center gap-2" style={{fontSize:13,fontWeight:600,color:C.ink}}>
                        <StickyNote size={15} style={{color:'#B8870A'}}/> {selectedFile.name}
                      </div>
                      <div className="mono" style={{fontSize:9,color:C.inkFaint}}>{noteSaving?'Saving…':noteLoaded?'Saved':''}</div>
                    </div>
                    <textarea
                      className="flex-1 sans"
                      style={{resize:'none',width:'100%',padding:'14px 16px',borderRadius:6,border:`1px solid ${C.rule}`,backgroundColor:C.paperLight,color:C.ink,fontSize:13,lineHeight:1.6,outline:'none'}}
                      value={noteText??''}
                      placeholder="Type notes here…"
                      disabled={!noteLoaded}
                      onChange={e=>handleNoteChange(e.target.value)}
                    />
                  </div>
                ):selectedFile&&isImageFile(selectedFile.name)?(
                  <div className="mx-auto p-4" style={{width:'fit-content',maxWidth:'100%'}}>
                    {imageUrl
                      ?<img src={imageUrl} alt={selectedFile.name} style={{maxWidth:'100%',display:'block',borderRadius:2,boxShadow:'0 4px 24px rgba(26,22,18,0.3)'}}/>
                      :<div style={{color:C.inkFaint,fontSize:12,fontFamily:'Georgia,serif'}}>Loading…</div>
                    }
                  </div>
                ):selectedFile&&!isPdfFile(selectedFile.name)?(
                  <div className="mx-auto flex flex-col items-center justify-center" style={{minHeight:'60vh',maxWidth:420,textAlign:'center',gap:14,paddingTop:'12vh'}}>
                    {isExcelFile(selectedFile.name)
                      ?<FileSpreadsheet size={48} style={{color:'#2E7D4F'}}/>
                      :isWordFile(selectedFile.name)
                      ?<FileText size={48} style={{color:'#2C5F9E'}}/>
                      :<StickyNote size={48} style={{color:'#B8870A'}}/>}
                    <div className="serif" style={{fontSize:15,fontWeight:600,color:C.ink}}>{selectedFile.name}</div>
                    <div className="sans" style={{fontSize:12,color:C.inkMuted}}>
                      {isExcelFile(selectedFile.name)?'Excel':isWordFile(selectedFile.name)?'Word':'This'} file should have opened in your default program automatically. If it didn't, click below.
                    </div>
                    <button
                      className="px-4 py-1.5 rounded sans"
                      style={{fontSize:12,fontWeight:600,backgroundColor:C.ink,color:C.paperLight}}
                      onClick={async()=>{
                        const r=await api?.openFile(selectedFile.path)
                        if(!r?.ok) alert('Could not open file: '+(r?.error??'No application is associated with this file type.'))
                      }}
                    >
                      Open in default program
                    </button>
                  </div>
                ):(
                  <div className="mx-auto doc-shadow" style={{width:'fit-content'}}>
                    <PdfViewer pdfBytes={pdfBytes} zoom={zoom} page={currentPage} onPageCount={setPageCount} onPageSize={(w,h)=>setPageSize({w,h})} annotations={annotations} activeMark={activeMark} onAddTickmark={addTickmark} onMoveTickmark={moveTickmark} onAddTapeStamp={addTapeStamp} onDeleteTapeStamp={deleteTapeStamp} onMoveTapeStamp={moveTapeStamp} onAddHighlight={addHighlight} onDeleteHighlight={deleteHighlight} author={author}/>
                  </div>
                )}
              </div>
              {/* Big page-turn arrows */}
              {currentPage>1&&(
                <button onClick={()=>setCurrentPage(p=>Math.max(1,p-1))} title="Previous page"
                  className="absolute flex items-center justify-center"
                  style={{left:8,top:'50%',transform:'translateY(-50%)',width:44,height:64,borderRadius:8,backgroundColor:'rgba(26,22,18,0.18)',color:'#FEFCF7',fontSize:28,fontWeight:700,border:'none',cursor:'pointer',transition:'background-color 0.15s',zIndex:5}}
                  onMouseEnter={e=>e.currentTarget.style.backgroundColor='rgba(26,22,18,0.38)'}
                  onMouseLeave={e=>e.currentTarget.style.backgroundColor='rgba(26,22,18,0.18)'}
                >‹</button>
              )}
              {currentPage<pageCount&&(
                <button onClick={()=>setCurrentPage(p=>Math.min(pageCount,p+1))} title="Next page"
                  className="absolute flex items-center justify-center"
                  style={{right:8,top:'50%',transform:'translateY(-50%)',width:44,height:64,borderRadius:8,backgroundColor:'rgba(26,22,18,0.18)',color:'#FEFCF7',fontSize:28,fontWeight:700,border:'none',cursor:'pointer',transition:'background-color 0.15s',zIndex:5}}
                  onMouseEnter={e=>e.currentTarget.style.backgroundColor='rgba(26,22,18,0.38)'}
                  onMouseLeave={e=>e.currentTarget.style.backgroundColor='rgba(26,22,18,0.18)'}
                >›</button>
              )}
            </div>

            {/* ── Right rail ── */}
            {rightOpen&&(
              <div className="flex flex-col flex-shrink-0" style={{width:220,backgroundColor:C.paperLight,borderLeft:`1px solid ${C.rule}`}}>

                {/* 4 colored checkmarks */}
                <div className="flex items-center justify-around px-2 py-2 flex-shrink-0" style={{borderBottom:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
                  {CHECKS.map(c=>(
                    <button
                      key={c.id}
                      onClick={()=>setActiveMark(am=>am===c.id?'':c.id)}
                      title={c.label}
                      style={{
                        width:36, height:36, borderRadius:4,
                        backgroundColor:activeMark===c.id?c.color:'transparent',
                        border:`2px solid ${activeMark===c.id?c.color:C.rule}`,
                        display:'flex', alignItems:'center', justifyContent:'center',
                        cursor:'pointer', transition:'all 0.12s',
                      }}
                    >
                      <Check size={18} strokeWidth={3} style={{color:activeMark===c.id?'white':c.color}}/>
                    </button>
                  ))}
                </div>

                {/* Tabs */}
                <div className="flex items-center flex-shrink-0" style={{borderBottom:`1px solid ${C.rule}`}}>
                  {(['notes','xref','signoff'] as const).map(tab=>(
                    <button key={tab} onClick={()=>setRightTab(tab)} className="flex-1 py-2 sans relative" style={{fontSize:10,fontWeight:600,color:rightTab===tab?C.ink:C.inkMuted,backgroundColor:rightTab===tab?C.paperLight:C.paperDeep,letterSpacing:0.5}}>
                      <div className="flex items-center justify-center gap-1">
                        <span>{{notes:'Notes',xref:'Refs',signoff:'Sign'}[tab]}</span>
                        {tab==='notes'&&<span className="mono" style={{fontSize:8,padding:'0 4px',backgroundColor:rightTab===tab?C.ochre:C.rule,color:rightTab===tab?C.paperLight:C.inkSoft,borderRadius:6,fontWeight:600}}>{annotations.tickmarks.length}</span>}
                      </div>
                      {rightTab===tab&&<div className="absolute bottom-0 left-0 right-0" style={{height:2,backgroundColor:C.ochre}}/>}
                    </button>
                  ))}
                  <button onClick={()=>setRightOpen(false)} className="p-2" style={{color:C.inkMuted}}><PanelRightClose size={12}/></button>
                </div>

                {showCalculator&&(()=>{
                  const total=tapeEntries.reduce((s,e)=>s+e.value,0)
                  const totalStr=total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
                  const fmt=(v:number)=>v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
                  function addEntry(){
                    const v=parseFloat(tapeInput.replace(/,/g,''))
                    if(isNaN(v)) return
                    setTapeEntries(prev=>[...prev,{id:crypto.randomUUID(),value:v}])
                    setTapeInput('')
                  }
                  const canDrag=tapeEntries.length>0
                  return(
                    <div style={{borderBottom:`1px solid ${C.rule}`,maxHeight:280,display:'flex',flexDirection:'column'}}>
                      {/* Header — draggable when entries exist */}
                      <div
                        draggable={canDrag}
                        onDragStart={ev=>{
                          ev.dataTransfer.setData('type','tape-stamp')
                          ev.dataTransfer.setData('entries',JSON.stringify(tapeEntries.map(e=>({value:e.value}))))
                        }}
                        className="px-3 py-1.5 flex items-center justify-between flex-shrink-0"
                        style={{backgroundColor:C.ink,color:C.paperLight,cursor:canDrag?'grab':'default'}}
                        title={canDrag?'Drag tape onto PDF to stamp it':''}
                      >
                        <span className="serif" style={{fontSize:10,fontWeight:600}}>
                          {canDrag?'⠿ Drag Tape →':'Adding Machine Tape'}
                        </span>
                        <button onClick={()=>setTapeEntries([])} className="mono no-drag" style={{fontSize:9,color:C.inkFaint}}>clear</button>
                      </div>
                      {/* Entry list */}
                      <div className="flex-1 overflow-y-auto" style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,backgroundColor:'#FEFCF7',scrollbarWidth:'thin'}}>
                        {tapeEntries.length===0&&(
                          <div style={{color:C.inkMuted,padding:'6px 8px',fontSize:9}}>Type an amount and press Enter to add it.</div>
                        )}
                        {tapeEntries.map((e,i)=>(
                          <div key={e.id} className="flex items-center justify-between px-2 py-0.5 row-hover" style={{borderBottom:`1px dotted ${C.ruleSoft}`}}>
                            <span style={{color:C.inkFaint,fontSize:9,width:16}}>{i+1}</span>
                            <span style={{color:C.ink,flex:1,textAlign:'right'}}>{fmt(e.value)}</span>
                            <button onClick={()=>setTapeEntries(prev=>prev.filter(x=>x.id!==e.id))} style={{color:C.inkFaint,marginLeft:4,lineHeight:1}}><X size={9}/></button>
                          </div>
                        ))}
                      </div>
                      {/* Total line */}
                      <div className="flex justify-between px-2 py-1.5 flex-shrink-0"
                        style={{borderTop:`2px solid ${C.ink}`,backgroundColor:C.ochreSoft,fontWeight:700,fontFamily:'JetBrains Mono,monospace',fontSize:11}}>
                        <span style={{color:C.ochreDeep}}>Σ</span>
                        <span style={{color:C.ink}}>{totalStr}</span>
                      </div>
                      {/* Input */}
                      <div className="flex gap-1 px-2 py-1.5 flex-shrink-0" style={{borderTop:`1px solid ${C.ruleSoft}`,backgroundColor:C.paper}}>
                        <input
                          ref={tapeInputRef}
                          type="text" placeholder="0.00" value={tapeInput}
                          onChange={e=>setTapeInput(e.target.value)}
                          onKeyDown={e=>{
                            if(e.key==='Enter') addEntry()
                            else if(e.key==='Escape') setTapeInput('')
                            else if(e.key==='PageDown'){ e.preventDefault(); setCurrentPage(p=>Math.min(pageCount,p+1)); tapeInputRef.current?.focus() }
                            else if(e.key==='PageUp'){ e.preventDefault(); setCurrentPage(p=>Math.max(1,p-1)); tapeInputRef.current?.focus() }
                          }}
                          className="flex-1 outline-none mono px-1.5 py-1 rounded"
                          style={{fontSize:12,backgroundColor:C.paperDeep,border:`1px solid ${C.rule}`,color:C.ink,textAlign:'right'}}
                          autoFocus
                        />
                        <button onClick={addEntry} className="px-2 py-1 rounded sans" style={{fontSize:11,backgroundColor:C.ochre,color:C.paperLight,fontWeight:700}}>+</button>
                      </div>
                    </div>
                  )
                })()}

                <div className="flex-1 overflow-y-auto scrollbar-thin">
                  {rightTab==='notes'&&(
                    <div className="p-2 space-y-2">
                      {annotations.tickmarks.filter(t=>t.page===currentPage).length===0&&(
                        <div className="text-center py-4" style={{fontSize:10,color:C.inkFaint}}>No marks on this page.<br/>Click the document to place one.</div>
                      )}
                      {annotations.tickmarks.filter(t=>t.page===currentPage).map(tm=>{
                        const def=CHECKS.find(c=>c.id===tm.type)??CHECKS[0]
                        return(
                          <div key={tm.id} className="rounded relative overflow-hidden" style={{backgroundColor:'#FEFCF7',border:`1px solid ${C.ruleSoft}`}}>
                            <div style={{position:'absolute',left:0,top:0,bottom:0,width:3,backgroundColor:def.color}}/>
                            <div className="p-2.5 pl-3">
                              <div className="flex items-center gap-1.5 mb-1">
                                <Check size={11} style={{color:def.color,flexShrink:0}} strokeWidth={3}/>
                                <div className="serif flex-1" style={{fontSize:11,fontWeight:700,color:C.ink}}>{def.label}</div>
                                <button onClick={()=>deleteTickmark(tm.id)} style={{color:C.inkFaint,padding:'0 2px'}} title="Delete mark"><Trash2 size={10}/></button>
                              </div>
                              <div className="mono" style={{fontSize:9,color:C.inkSoft}}>{tm.note} · pg {tm.page} · {new Date(tm.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
                            </div>
                          </div>
                        )
                      })}
                      <button className="w-full py-2 rounded sans" style={{fontSize:10,backgroundColor:'transparent',border:`1px dashed ${C.rule}`,color:C.inkMuted,fontWeight:500}}>+ Add note</button>
                    </div>
                  )}
                  {rightTab==='xref'&&(
                    <div className="p-2"><div className="text-center py-4" style={{fontSize:10,color:C.inkFaint}}>Cross-references will appear here.</div></div>
                  )}
                  {rightTab==='signoff'&&(
                    <div className="p-2 space-y-2">
                      <div className="rounded overflow-hidden" style={{backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`}}>
                        <div className="px-2.5 py-1.5" style={{backgroundColor:C.ochreSoft,borderBottom:`1px solid ${C.ochreLight}`}}>
                          <div className="serif" style={{fontSize:9,fontWeight:700,color:C.ochreDeep,letterSpacing:1,textTransform:'uppercase'}}>Page {currentPage}</div>
                        </div>
                        <div className="p-2.5 space-y-2">
                          {['Preparer','Reviewer','Partner'].map(role=>{
                            const so=annotations.signoffs.find(s=>s.page===currentPage&&s.role===role)
                            return(
                              <div key={role} className="flex items-center gap-2">
                                <div style={{width:18,height:18,borderRadius:'50%',backgroundColor:so?'#5C8A3A':'transparent',border:so?'none':`1.5px dashed ${C.rule}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                                  {so&&<Check size={10} strokeWidth={3} style={{color:'white'}}/>}
                                </div>
                                <div className="flex-1">
                                  <div className="sans" style={{fontSize:10,color:C.ink,fontWeight:600}}>{role}</div>
                                  <div className="mono" style={{fontSize:8,color:C.inkMuted}}>{so?`${so.author} · ${new Date(so.signedAt).toLocaleDateString()}`:'pending'}</div>
                                </div>
                                {so&&<button onClick={()=>deleteSignoff(currentPage,role)} style={{color:C.inkFaint}} title="Remove signoff"><Trash2 size={10}/></button>}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      <div className="rounded overflow-hidden" style={{backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`}}>
                        <div className="px-2.5 py-1.5" style={{backgroundColor:C.paperDeep,borderBottom:`1px solid ${C.rule}`}}>
                          <div className="flex items-center justify-between">
                            <span className="serif" style={{fontSize:9,fontWeight:700,color:C.inkSoft,letterSpacing:1,textTransform:'uppercase'}}>Document</span>
                            <span className="mono" style={{fontSize:9,color:C.inkMuted}}>{pageCount} pgs</span>
                          </div>
                        </div>
                        <div className="p-2.5 space-y-1.5" style={{fontSize:10}}>
                          {['Preparer','Reviewer','Partner'].map((role,i)=>{
                            const count=annotations.signoffs.filter(s=>s.role===role).length
                            const pct=pageCount>0?(count/pageCount)*100:0
                            const colors=['#5C8A3A',C.ochre,C.inkFaint]
                            return(
                              <div key={role}>
                                <div className="flex justify-between mb-1">
                                  <span style={{color:C.ink}}>{role}</span>
                                  <span className="mono" style={{color:C.inkSoft,fontWeight:600}}>{count}/{pageCount}</span>
                                </div>
                                <div className="h-1 rounded-full overflow-hidden" style={{backgroundColor:C.paperDeep}}>
                                  <div className="h-full transition-all" style={{width:`${pct}%`,backgroundColor:colors[i]}}/>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Status bar */}
          <div className="flex items-center justify-between px-3 py-1 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
            <div className="flex items-center gap-3" style={{fontSize:9}}>
              <span className="mono">PG {currentPage}·{pageCount}</span>
              <span style={{color:C.inkFaint}}>·</span>
              <div className="flex items-center gap-1">
                <div className="pulse" style={{width:5,height:5,borderRadius:'50%',backgroundColor:'#7DBE5C'}}/>
                <span style={{color:C.inkFaint}}>Autosave</span>
              </div>
            </div>
            <div className="flex items-center gap-3" style={{fontSize:9}}>
              {selectedFile&&annotations.addedAt&&(
                <>
                  <span className="mono" style={{color:C.inkFaint}}>
                    Added {new Date(annotations.addedAt).toLocaleDateString()} by <span style={{color:C.ochreLight}}>{annotations.addedBy||'Unknown'}</span>
                  </span>
                  <span style={{color:C.inkFaint}}>·</span>
                </>
              )}
              {selectedClient&&<span className="mono" style={{color:C.inkFaint}}><span style={{color:C.ochreLight}}>TaxDome</span> {selectedClient}</span>}
              {selectedClient&&appVersion&&<span style={{color:C.inkFaint}}>·</span>}
              {appVersion&&(
                <button className="mono" onClick={handleCheckForUpdates} title="Check for updates"
                  style={{color:updateReady?C.ochre:C.inkFaint,background:'none',border:'none',padding:0,cursor:'pointer',fontSize:'inherit'}}>
                  v{appVersion}{updateReady?' ↑':''}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Rename modal ── */}
      {renaming&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={()=>setRenaming(null)}>
          <div className="rounded overflow-hidden" style={{width:420,backgroundColor:C.paperLight,border:`1px solid ${C.rule}`,boxShadow:'0 8px 32px rgba(26,22,18,0.25)'}} onClick={e=>e.stopPropagation()}>
            <div className="px-4 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
              <div className="serif" style={{fontSize:13,fontWeight:600}}>Rename File</div>
              <div className="mono truncate" style={{fontSize:10,color:C.inkFaint,marginTop:2}}>{renaming.file.name}</div>
            </div>
            <div className="p-4">
              <div className="sans" style={{fontSize:11,color:C.inkMuted,marginBottom:8}}>New name:</div>
              <input
                autoFocus
                className="w-full outline-none sans"
                style={{fontSize:14,color:C.ink,backgroundColor:C.paper,border:`1px solid ${C.ochre}`,borderRadius:4,padding:'7px 10px',width:'100%',boxSizing:'border-box'}}
                value={renaming.value}
                onChange={e=>setRenaming({...renaming,value:e.target.value})}
                onKeyDown={e=>{if(e.key==='Enter')handleRename();if(e.key==='Escape')setRenaming(null)}}
              />
              <div className="mono" style={{fontSize:10,color:C.inkFaint,marginTop:5}}>
                Extension <strong>{renaming.file.name.match(/\.[^.]+$/)?.[0]??''}</strong> will be preserved
              </div>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
              <button onClick={()=>setRenaming(null)} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
              <button onClick={handleRename} className="px-4 py-1.5 rounded sans" style={{fontSize:12,fontWeight:600,backgroundColor:C.ink,color:C.paperLight}}>Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New subfolder modal ── */}
      {newSubfolder&&(
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.4)'}} onClick={()=>setNewSubfolder(null)}>
          <div className="rounded overflow-hidden" style={{width:420,backgroundColor:C.paperLight,border:`1px solid ${C.rule}`,boxShadow:'0 8px 32px rgba(26,22,18,0.25)'}} onClick={e=>e.stopPropagation()}>
            <div className="px-4 py-3 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
              <div className="serif" style={{fontSize:13,fontWeight:600}}>New Subfolder</div>
              <div className="mono truncate" style={{fontSize:10,color:C.inkFaint,marginTop:2}}>in {newSubfolder.parent.name}</div>
            </div>
            <div className="p-4">
              <div className="sans" style={{fontSize:11,color:C.inkMuted,marginBottom:8}}>Folder name:</div>
              <input
                autoFocus
                className="w-full outline-none sans"
                style={{fontSize:14,color:C.ink,backgroundColor:C.paper,border:`1px solid ${C.ochre}`,borderRadius:4,padding:'7px 10px',width:'100%',boxSizing:'border-box'}}
                value={newSubfolder.value}
                onChange={e=>setNewSubfolder({...newSubfolder,value:e.target.value})}
                onKeyDown={e=>{if(e.key==='Enter')handleCreateSubfolder();if(e.key==='Escape')setNewSubfolder(null)}}
              />
            </div>
            <div className="flex justify-end gap-2 px-4 py-3" style={{borderTop:`1px solid ${C.rule}`,backgroundColor:C.paperDeep}}>
              <button onClick={()=>setNewSubfolder(null)} className="px-4 py-1.5 rounded sans" style={{fontSize:12,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}>Cancel</button>
              <button onClick={handleCreateSubfolder} disabled={!newSubfolder.value.trim()} className="px-4 py-1.5 rounded sans" style={{fontSize:12,fontWeight:600,backgroundColor:C.ink,color:C.paperLight,opacity:newSubfolder.value.trim()?1:0.5}}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Context menu ── */}
      {ctxMenu&&(()=>{
        // Files affected: multiselect if >1, else just the right-clicked file
        const affectedFiles=multiSelect.length>1?multiSelect:[ctxMenu.file]
        const isBulk=affectedFiles.length>1
        return(
          <div className="fixed z-50 rounded overflow-hidden" style={{left:ctxMenu.x,top:ctxMenu.y,backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`,boxShadow:'0 4px 16px rgba(26,22,18,0.15)',minWidth:220}} onClick={e=>e.stopPropagation()}>
            <div className="px-3 py-1.5" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
              <div className="truncate sans" style={{fontSize:11,color:C.inkMuted,maxWidth:260}}>
                {isBulk?`${affectedFiles.length} files selected`:ctxMenu.file.name}
              </div>
            </div>
            {!isBulk&&(
              <>
                <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink}} onClick={()=>{setEditFileModal(ctxMenu.file);setCtxMenu(null)}}>
                  📄 <span>Edit File…</span>
                </button>
                <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}} onClick={()=>{setRenaming({file:ctxMenu.file,value:ctxMenu.file.name.replace(/\.[^.]+$/,'')});setCtxMenu(null)}}>
                  ✏️ <span>Rename</span>
                </button>
              </>
            )}
            <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}} onClick={()=>{setMoveDrawer(affectedFiles);setCtxMenu(null)}}>
              📁 <span>{isBulk?`Move ${affectedFiles.length} files to Another Drawer`:'Move to Another Drawer'}</span>
            </button>
            <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}} onClick={()=>{setEmailModal({items:affectedFiles.map(f=>({name:f.name,path:f.path})),clientFiles:flatFiles(docTree)});setCtxMenu(null)}}>
              ✉️ <span>{isBulk?`Email ${affectedFiles.length} Files…`:'Email File…'}</span>
            </button>
            {!isBulk&&(
              <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:'#B5443A',borderTop:`1px solid ${C.ruleSoft}`}}
                onClick={()=>{
                  if(!confirm(`Delete "${ctxMenu.file.name}"? This cannot be undone.`)) return
                  api?.deleteFile(ctxMenu.file.path).then(r=>{
                    if(!r.ok) alert('Delete failed: '+(r.error??''))
                    else{ if(selectedFile?.path===ctxMenu.file.path) setSelectedFile(null); refreshDocs(300) }
                  })
                  setCtxMenu(null)
                }}>
                🗑️ <span>Delete</span>
              </button>
            )}
          </div>
        )
      })()}

      {/* ── Folder context menu ── */}
      {ctxFolder&&(
        <div className="fixed z-50 rounded overflow-hidden" style={{left:ctxFolder.x,top:ctxFolder.y,backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`,boxShadow:'0 4px 16px rgba(26,22,18,0.15)',minWidth:200}} onClick={e=>e.stopPropagation()}>
          <div className="px-3 py-1.5" style={{borderBottom:`1px solid ${C.ruleSoft}`,backgroundColor:C.paperDeep}}>
            <div className="truncate sans" style={{fontSize:11,color:C.inkMuted}}>{ctxFolder.folder.name}</div>
          </div>
          {!ctxFolder.hoistOnly&&(
            <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink}}
              onClick={()=>{setEditFolderModal(ctxFolder.folder);setCtxFolder(null)}}>
              🗂️ <span>Edit Folder…</span>
            </button>
          )}
          {!ctxFolder.hoistOnly&&(
            <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}}
              onClick={()=>{setNewSubfolder({parent:ctxFolder.folder,value:''});setCtxFolder(null)}}>
              ➕ <span>New Subfolder…</span>
            </button>
          )}
          <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:ctxFolder.hoistOnly?'none':`1px solid ${C.ruleSoft}`}}
            disabled={hoisting}
            onClick={async()=>{
              const folder=ctxFolder.folder
              setCtxFolder(null)
              setHoisting(true)
              const r=await api?.hoistFolder(folder.path)
              setHoisting(false)
              if(r?.ok&&r.path) setHoisted({folder:folder.path,path:r.path})
              else alert('Could not hoist folder: '+(r?.error??'Unknown error'))
            }}>
            📦 <span>Hoist…</span>
          </button>
          <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}}
            onClick={async()=>{
              const folder=ctxFolder.folder
              setCtxFolder(null)
              const r=await api?.testWriteAccess(folder.path)
              if(r?.ok) alert(`✓ This computer can write to:\n${folder.path}`)
              else alert(`✗ Cannot write to:\n${folder.path}\n\n${r?.error??'Unknown error'}`)
            }}>
            🔧 <span>Test Folder Access</span>
          </button>
          <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:`1px solid ${C.ruleSoft}`}}
            onClick={()=>{setUploadRequestModal({folderPath:ctxFolder.folder.path,folderName:ctxFolder.folder.name});setCtxFolder(null)}}>
            📥 <span>Request Documents…</span>
          </button>
        </div>
      )}

      {/* ── Move-to-drawer modal ── */}
      {moveDrawer&&(
        <MoveToDrawerModal
          files={moveDrawer} clients={clients} rootPath={rootPath}
          onClose={()=>setMoveDrawer(null)}
          onMove={async destFolder=>{
            if(!api) return
            const errors:string[]=[]
            for(const f of moveDrawer){
              const r=await api.moveFile(f.path,destFolder)
              if(!r.ok) errors.push(r.error??f.name)
            }
            if(errors.length) alert(`Some files could not be moved:\n${errors.join('\n')}`)
            const movedPaths=new Set(moveDrawer.map(f=>f.path))
            if(selectedFile&&movedPaths.has(selectedFile.path)) setSelectedFile(null)
            setMultiSelect([])
            setMoveDrawer(null)
            refreshDocs(800)
          }}
        />
      )}

      {/* ── Edit File modal ── */}
      {editFileModal&&(
        <EditFileModal file={editFileModal} bookmarkButtons={appBookmarkButtons} onBookmarkButtonsChange={btns=>{setAppBookmarkButtons(btns)}} onClose={()=>setEditFileModal(null)} onSaved={()=>{
          const p=editFileModal.path
          setFileBookmarks(prev=>{const n={...prev};delete n[p];return n})
          setExpandedBookmarks(prev=>{const n=new Set(prev);n.delete(p);return n})
          refreshDocs(800)
          if(selectedFile?.path===p&&api)
            api.readPdf(p).then(b=>{ if(b) setPdfBytes(b) })
        }}/>
      )}

      {/* ── Edit Folder modal ── */}
      {editFolderModal&&(
        <EditFolderModal folder={editFolderModal} docTree={docTree} onClose={()=>setEditFolderModal(null)} onSaved={()=>refreshDocs(800)}/>
      )}

      {/* ── Scan destination modal ── */}
      {showScanModal&&(
        <ScanDestModal clients={clients} rootPath={rootPath} defaultClient={selectedClient} defaultFolderPath={activeFolder?.path??null} defaultAppendFile={selectedFile&&isPdfFile(selectedFile.name)?{path:selectedFile.path,name:selectedFile.name}:null} onClose={()=>setShowScanModal(false)} onStarted={()=>setScanning(true)} onFailed={()=>setScanning(false)}/>
      )}

      {/* ── Scan settings modal ── */}
      {showScanSettings&&(
        <ScanSettingsModal onClose={()=>setShowScanSettings(false)}/>
      )}

      {showNamePrompt&&(
        <UserNameModal initialValue={author} onSave={saveUserName}/>
      )}

      {showMagicLinkSettings&&(
        <MagicLinkSettingsModal onClose={()=>setShowMagicLinkSettings(false)}/>
      )}

      {uploadRequestModal&&(
        <RequestUploadModal
          folderPath={uploadRequestModal.folderPath}
          folderName={uploadRequestModal.folderName}
          author={author}
          onClose={()=>setUploadRequestModal(null)}
          onCreated={async()=>{
            const reqs=await api?.listUploadRequests()??{}
            setUploadRequests(reqs)
          }}
        />
      )}

      {uploadInboxModal&&(
        <UploadInboxModal
          onClose={()=>setUploadInboxModal(false)}
          onSaved={()=>{ refreshDocsRef.current(300); setUploadBadge(b=>Math.max(0,b-1)) }}
        />
      )}

      {emailModal&&(
        <EmailLinkModal initialItems={emailModal.items} clientFiles={emailModal.clientFiles} author={author} onClose={()=>setEmailModal(null)}/>
      )}

      {/* ── Hoist freeze overlay ── */}
      {(hoisting||hoisted)&&(
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.65)'}}>
          <div className="rounded-lg" style={{backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`,boxShadow:'0 8px 32px rgba(26,22,18,0.35)',minWidth:420,maxWidth:560,padding:'24px 28px'}}>
            {hoisting?(
              <>
                <div className="serif" style={{fontSize:16,fontWeight:600,color:C.ink,marginBottom:8}}>📦 Hoisting folder…</div>
                <div className="sans" style={{fontSize:12,color:C.inkMuted}}>Copying contents to a temporary cabinet. Please wait.</div>
              </>
            ):hoisted&&(
              <>
                <div className="serif" style={{fontSize:16,fontWeight:600,color:C.ink,marginBottom:8}}>📦 Folder Hoisted</div>
                <div className="sans" style={{fontSize:12,color:C.inkMuted,marginBottom:6}}>
                  All contents of <strong>{hoisted.folder.split('\\').pop()}</strong> have been copied to a temporary cabinet:
                </div>
                <div className="mono" style={{fontSize:11,color:C.ink,backgroundColor:C.paperDeep,border:`1px solid ${C.ruleSoft}`,borderRadius:4,padding:'8px 10px',wordBreak:'break-all',marginBottom:14}}>
                  {hoisted.path}
                </div>
                <div className="sans" style={{fontSize:12,color:C.inkMuted,marginBottom:16}}>
                  The app is paused while the folder is hoisted. When you're done, click <strong>Unhoist</strong> to permanently delete the temporary copy (the original folder is untouched).
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    className="px-4 py-1.5 rounded sans flex items-center gap-1.5"
                    style={{fontSize:12,fontWeight:600,border:`1px solid ${C.rule}`,color:C.inkSoft,backgroundColor:C.paper}}
                    onClick={()=>{ navigator.clipboard.writeText(hoisted.path).catch(()=>{}) }}
                  >
                    <Copy size={13}/> Copy Path
                  </button>
                  <button
                    className="px-4 py-1.5 rounded sans"
                    style={{fontSize:12,fontWeight:600,backgroundColor:C.ink,color:C.paperLight}}
                    onClick={async()=>{
                      setHoisting(true)
                      const r=await api?.unhoistFolder(hoisted.path,hoisted.folder)
                      setHoisting(false)
                      if(!r?.ok) alert('Could not unhoist: '+(r?.error??'Unknown error'))
                      setHoisted(null)
                    }}
                  >
                    Unhoist
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Client info modal ── */}
      {clientInfo&&(
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{backgroundColor:'rgba(26,22,18,0.5)'}} onClick={()=>setClientInfo(null)}>
          <div className="rounded-lg" style={{backgroundColor:'#FEFCF7',border:`1px solid ${C.rule}`,boxShadow:'0 8px 32px rgba(26,22,18,0.35)',minWidth:360,maxWidth:480,padding:'20px 24px'}} onClick={e=>e.stopPropagation()}>
            <div className="serif flex items-center gap-2" style={{fontSize:15,fontWeight:600,color:C.ink,marginBottom:12}}>
              <CreditCard size={16} style={{color:C.ochre}}/> Client Info
            </div>
            {clientInfo.loading?(
              <div className="sans" style={{fontSize:12,color:C.inkMuted}}>Reading tax form…</div>
            ):clientInfo.error?(
              <div className="sans" style={{fontSize:12,color:'#B5443A'}}>{clientInfo.error}</div>
            ):(
              <>
                <div className="sans" style={{fontSize:11,color:C.inkMuted,marginBottom:2}}>Name</div>
                <div className="flex items-center gap-2" style={{marginBottom:10}}>
                  <div className="serif" style={{fontSize:14,fontWeight:600,color:C.ink}}>{clientInfo.name??'(not found)'}</div>
                  {clientInfo.name&&(
                    <button title="Copy name" className="p-1 rounded row-hover" style={{color:C.inkFaint,display:'flex',alignItems:'center'}} onClick={()=>{navigator.clipboard.writeText(clientInfo.name!).catch(()=>{})}}>
                      <Copy size={13}/>
                    </button>
                  )}
                </div>
                <div className="sans" style={{fontSize:11,color:C.inkMuted,marginBottom:2}}>{clientInfo.idLabel??'ID'}</div>
                <div className="flex items-center gap-2" style={{marginBottom:clientInfo.spouseSsn?2:10}}>
                  <div className="mono" style={{fontSize:14,fontWeight:600,color:C.ink}}>{clientInfo.idValue??'(not found)'}</div>
                  {clientInfo.idValue&&(
                    <button title="Copy" className="p-1 rounded row-hover" style={{color:C.inkFaint,display:'flex',alignItems:'center'}} onClick={()=>{navigator.clipboard.writeText(clientInfo.idValue!).catch(()=>{})}}>
                      <Copy size={13}/>
                    </button>
                  )}
                </div>
                {clientInfo.spouseSsn&&(
                  <>
                    <div className="sans" style={{fontSize:11,color:C.inkMuted,marginBottom:2}}>Spouse SSN</div>
                    <div className="flex items-center gap-2" style={{marginBottom:10}}>
                      <div className="mono" style={{fontSize:14,fontWeight:600,color:C.ink}}>{clientInfo.spouseSsn}</div>
                      <button title="Copy" className="p-1 rounded row-hover" style={{color:C.inkFaint,display:'flex',alignItems:'center'}} onClick={()=>{navigator.clipboard.writeText(clientInfo.spouseSsn!).catch(()=>{})}}>
                        <Copy size={13}/>
                      </button>
                    </div>
                  </>
                )}
                <div className="sans" style={{fontSize:10,color:C.inkFaint}}>
                  Extracted from <strong>{clientInfo.formName}</strong> — please verify against the source document.
                </div>
              </>
            )}
            <div className="flex justify-end" style={{marginTop:16}}>
              <button className="px-4 py-1.5 rounded sans" style={{fontSize:12,fontWeight:600,backgroundColor:C.ink,color:C.paperLight}} onClick={()=>setClientInfo(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scan toasts ── */}
      {updateStatus&&(
        <div className="fixed bottom-4 left-1/2 z-50 sans" style={{transform:'translateX(-50%)',backgroundColor:C.ink,color:C.paperLight,borderRadius:6,padding:'10px 18px',fontSize:13,boxShadow:'0 4px 16px rgba(26,22,18,0.3)',display:'flex',alignItems:'center',gap:10,maxWidth:480}}>
          {updateStatus.type==='info'&&<RefreshCw size={13} style={{color:C.inkFaint,flexShrink:0}}/>}
          {updateStatus.type==='success'&&<Check size={13} style={{color:'#7BC95A',flexShrink:0}}/>}
          {updateStatus.type==='error'&&<X size={13} style={{color:'#B5443A',flexShrink:0}}/>}
          <span>{updateStatus.message}</span>
          <button onClick={()=>setUpdateStatus(null)} style={{color:C.inkFaint,marginLeft:4}}><X size={12}/></button>
        </div>
      )}

      {scanToasts.length>0&&(
        <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
          {scanToasts.map(t=>(
            <div key={t.id} className="flex items-center gap-2 px-4 py-2.5 rounded sans" style={{backgroundColor:C.ink,color:C.paperLight,boxShadow:'0 4px 16px rgba(26,22,18,0.3)',fontSize:13}}>
              <Check size={14} style={{color:'#7BC95A',flexShrink:0}}/>
              <span>Scanned: <strong>{t.name}</strong></span>
              <button onClick={()=>setScanToasts(prev=>prev.filter(x=>x.id!==t.id))} style={{color:C.inkFaint,marginLeft:4}}><X size={12}/></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
