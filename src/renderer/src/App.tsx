import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, FolderOpen, FolderClosed, FileText, Check, X,
  ChevronRight, ChevronDown, FileSignature, ZoomIn, ZoomOut, Maximize2,
  MessageSquare, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen,
  Clock, Layers, Settings, ScanLine, ArrowLeft, Merge, Printer,
  RefreshCw, Trash2, Calculator,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tickmark  { id:string; page:number; x:number; y:number; type:string; note:string; author:string; createdAt:string }
interface Signoff   { page:number; role:string; author:string; signedAt:string }
interface TapeStamp { id:string; page:number; x:number; y:number; entries:{value:number}[]; author:string; createdAt:string }
interface Annotations { tickmarks:Tickmark[]; signoffs:Signoff[]; tapeStamps?:TapeStamp[] }
interface DocFile  { name:string; type:'file';   path:string; annotations:Annotations }
interface DocFolder{ name:string; type:'folder'; path:string; children:(DocFile|DocFolder)[] }
interface Bookmark { title:string; page:number|null; items:Bookmark[] }

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
  startScan:       (destFolder:string,useNativeUI:boolean,dpi?:number,colorMode?:string,scanName?:string,skipBlank?:boolean)=>Promise<{ok:boolean;error?:string}>
  listFolder:      (p:string)=>Promise<(DocFile|DocFolder)[]>
  listScanDevices: ()=>Promise<{ok:boolean;devices:{ID:string;Name:string}[];error?:string}>
  stopScanWatcher: ()=>Promise<void>
  onScanFile:      (cb:(data:{name:string})=>void)=>void
  onScanError:     (cb:(err:string)=>void)=>void
  onScanProgress:  (cb:(data:{page:number})=>void)=>void
  pickFolder:     ()=>Promise<string|null>
  deleteFile:     (p:string)=>Promise<{ok:boolean;error?:string}>
  copyFile:       (p:string)=>Promise<{ok:boolean;error?:string;destPath?:string}>
  savePdf:        (p:string,b:ArrayBuffer)=>Promise<{ok:boolean;error?:string}>
  renameFolder:   (p:string,n:string)=>Promise<{ok:boolean;error?:string;newPath?:string}>
  getConfig:      (k:string)=>Promise<unknown>
  setConfig:      (k:string,v:unknown)=>Promise<boolean>
  printFile:      (p:string)=>Promise<{ok:boolean;error?:string}>
  printBytes:     (b:ArrayBuffer)=>Promise<{ok:boolean;error?:string}>
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

function EditFileModal({file,onClose,onSaved}:{file:DocFile;onClose:()=>void;onSaved:()=>void}){
  const [thumbs,setThumbs]           = useState<string[]>([])
  const [pageCount,setPageCount]     = useState(0)
  const [loading,setLoading]         = useState(true)
  const [loadPct,setLoadPct]         = useState(0)
  const [selPage,setSelPage]         = useState(0)
  const [assignments,setAssignments] = useState<Record<number,string>>({})
  const [buttons,setButtons]         = useState<BmBtn[]>([])
  const [newLabel,setNewLabel]       = useState('')
  const [saving,setSaving]           = useState(false)
  const [progress,setProgress]       = useState(0)
  const [loadError,setLoadError]     = useState<string|null>(null)
  const [thumbZoom,setThumbZoom]     = useState(160)
  const pageListRef                  = useRef<HTMLDivElement|null>(null)
  const pageItemRefs                 = useRef<(HTMLDivElement|null)[]>([])

  // Load buttons + thumbnail zoom from persistent config file on first open
  useEffect(()=>{
    api?.getConfig('bookmarkButtons').then(b=>{ if(Array.isArray(b)) setButtons(b as BmBtn[]) })
    api?.getConfig('editorThumbZoom').then(v=>{ if(typeof v==='number'&&v>0) setThumbZoom(v) })
  },[])

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
    setButtons(btns)
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

      // ── Pass 1: reorder pages only, save to clean bytes ──────────────────────
      const srcDoc=await PDFDocument.load(bytes)
      const n=srcDoc.getPageCount()

      const assigned:number[]=[]
      for(const btn of buttons){
        for(let i=0;i<n;i++) if(assignments[i]===btn.id&&!assigned.includes(i)) assigned.push(i)
      }
      const unassigned=Array.from({length:n},(_,i)=>i).filter(i=>!assigned.includes(i))
      const order=[...assigned,...unassigned]

      setProgress(35)
      const doc1=await PDFDocument.create()
      const copiedPages=await doc1.copyPages(srcDoc,order)
      copiedPages.forEach(p=>doc1.addPage(p))
      setProgress(55)
      const cleanBytes=await doc1.save({useObjectStreams:false})
      setProgress(65)

      // ── Pass 2: load clean bytes, add outline, save final ────────────────────
      const newAssign:Record<number,string>={}
      order.forEach((origIdx,newIdx)=>{ if(assignments[origIdx]) newAssign[newIdx]=assignments[origIdx] })
      // Build hierarchical bookmark groups: one parent per button, children = each assigned page
      interface BmGroup { title:string; pages:number[] }
      const bmGroups:BmGroup[]=[]
      for(const btn of buttons){
        const pages:number[]=[]
        for(let pg=0;pg<order.length;pg++) if(newAssign[pg]===btn.id) pages.push(pg)
        if(pages.length>0) bmGroups.push({title:btn.label,pages})
      }

      let finalBytes=cleanBytes
      if(bmGroups.length>0){
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

          // Create parent refs (one per button group)
          const parentRefs=bmGroups.map(g=>{
            const d=PDFDict.withContext(ctx)
            d.set(PDFName.of('Title'),PDFHexString.fromText(g.title))
            d.set(PDFName.of('Dest'),makeDest(g.pages[0]))
            return ctx.register(d)
          })

          // Create children for groups with >1 page
          const childRefsByGroup=bmGroups.map((g,gi)=>{
            if(g.pages.length<=1) return null
            const refs=g.pages.map((pageIdx,i)=>{
              const d=PDFDict.withContext(ctx)
              d.set(PDFName.of('Title'),PDFHexString.fromText(`Page ${i+1}`))
              d.set(PDFName.of('Dest'),makeDest(pageIdx))
              return ctx.register(d)
            })
            refs.forEach((ref,i)=>{
              const d=ctx.lookup(ref) as PDFDict
              d.set(PDFName.of('Parent'),parentRefs[gi])
              if(i>0) d.set(PDFName.of('Prev'),refs[i-1])
              if(i<refs.length-1) d.set(PDFName.of('Next'),refs[i+1])
            })
            return refs
          })

          // Wire parent First/Last/Count for groups with children
          parentRefs.forEach((pRef,gi)=>{
            const pd=ctx.lookup(pRef) as PDFDict
            const ch=childRefsByGroup[gi]
            if(ch&&ch.length>0){
              pd.set(PDFName.of('First'),ch[0])
              pd.set(PDFName.of('Last'),ch[ch.length-1])
              pd.set(PDFName.of('Count'),PDFNumber.of(-ch.length)) // negative = collapsed by default
            }
          })

          // Wire parent Prev/Next chain
          parentRefs.forEach((ref,i)=>{
            const d=ctx.lookup(ref) as PDFDict
            if(i>0) d.set(PDFName.of('Prev'),parentRefs[i-1])
            if(i<parentRefs.length-1) d.set(PDFName.of('Next'),parentRefs[i+1])
          })

          const totalVisible=bmGroups.reduce((s,g)=>s+(g.pages.length<=1?1:1+g.pages.length),0)
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
                          <span className="sans" style={{fontSize:10,color:C.ochreDeep,backgroundColor:C.ochreLight,padding:'1px 5px',borderRadius:3,fontWeight:600}}>
                            {buttons.find(b=>b.id===assignments[i])?.label}
                          </span>
                          <button onClick={e=>{e.stopPropagation();setAssignments(p=>{const n={...p};delete n[i];return n})}} style={{color:C.inkFaint}}><X size={9}/></button>
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
                  <button onClick={()=>{
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
          const doc=await PDFDocument.load(bytes)
          const pages=await merged.copyPages(doc,doc.getPageIndices())
          pages.forEach(p=>merged.addPage(p))
        }
        setProgress(75)
        const saved=await merged.save({useObjectStreams:false})
        const keepIdx=Math.min(outputFileIdx,selected.length-1)
        const keepPath=selected[keepIdx].path
        const r=await api.savePdf(keepPath,saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength))
        if(!r.ok) throw new Error(r.error)
        // Delete the other selected files
        for(const f of selected){ if(f.path!==keepPath) await api.deleteFile(f.path) }
      } else if(action==='move'){
        for(let i=0;i<selected.length;i++){
          setProgress(10+Math.round(i/selected.length*85))
          const r=await api.moveFile(selected[i].path,destPath)
          if(!r.ok) throw new Error(r.error)
        }
      } else {
        for(let i=0;i<selected.length;i++){
          setProgress(10+Math.round(i/selected.length*85))
          const newName=(renames[selected[i].path]||selected[i].name.replace(/\.[^.]+$/,''))+'.pdf'
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
  onAddTapeStamp:(s:Omit<TapeStamp,'id'|'author'|'createdAt'>)=>void
  onDeleteTapeStamp:(id:string)=>void
  onMoveTapeStamp:(id:string,x:number,y:number)=>void
  author:string
}

function PdfViewer({pdfBytes,zoom,page,onPageCount,onPageSize,annotations,activeMark,onAddTickmark,onAddTapeStamp,onDeleteTapeStamp,onMoveTapeStamp,author}:PdfViewerProps){
  const [dragStamp,setDragStamp]=useState<{id:string;x:number;y:number}|null>(null)
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

  function handleClick(e:React.MouseEvent<HTMLDivElement>){
    if(!activeMark) return // no mark type selected — clicking does nothing
    const c=coordsFromEvent(e); if(!c) return
    onAddTickmark({page,x:c.x,y:c.y,type:activeMark,note:author})
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
  const checkDefs:{[k:string]:{color:string}}=Object.fromEntries(CHECKS.map(c=>[c.id,{color:c.color}]))

  return(
    <div className="relative inline-block" style={{cursor:activeMark?'crosshair':'default'}}
      onClick={handleClick}
      onDragOver={e=>e.preventDefault()}
      onDrop={handleDrop}
    >
      {pdfBytes
        ?<canvas ref={canvasRef} style={{display:'block'}}/>
        :<div style={{width:540,minHeight:700,backgroundColor:'#FEFCF7',display:'flex',alignItems:'center',justifyContent:'center',color:C.inkFaint,fontFamily:'Georgia,serif',fontSize:13}}>No document selected</div>
      }
      {pageAnns.map(tm=>{
        const def=checkDefs[tm.type]??{color:C.ochre}
        return(
          <div key={tm.id} className="absolute" style={{left:`${tm.x}%`,top:`${tm.y}%`,transform:'translate(-50%,-50%)',pointerEvents:'none',zIndex:10}}>
            <div style={{backgroundColor:def.color,color:'white',fontSize:9,fontWeight:700,padding:'2px 5px',borderRadius:2,boxShadow:`0 2px 4px rgba(26,22,18,0.15),0 0 0 1.5px ${def.color},0 0 0 2.5px ${C.paperLight}`,fontFamily:'JetBrains Mono,monospace'}}>
              ✓ {tm.note}
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

function ScanDestModal({clients,rootPath,onClose,onStarted,onFailed}:{clients:string[];rootPath:string;onClose:()=>void;onStarted:()=>void;onFailed:()=>void}){
  const [search,setSearch]           = useState('')
  const [targetClient,setTargetClient] = useState<string|null>(null)
  const [folderTree,setFolderTree]   = useState<(DocFile|DocFolder)[]>([])
  const [destFolder,setDestFolder]   = useState<string|null>(null)
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
      setDestFolder(cp)
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
    const r=await api.startScan(destFolder,useNativeUI,scanDpi,colorMode,scanName.trim()||undefined,skipBlank)
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
          <div className="flex items-center justify-between mb-2">
            <div className="mono truncate" style={{fontSize:11,color:C.inkMuted,flex:1,marginRight:16}}>{destFolder?`→ ${destFolder}`:'No folder selected'}</div>
          </div>
          {/* File name input + name buttons */}
          <div className="mb-2.5">
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
  const [devices,setDevices]   = useState<{ID:string;Name:string}[]>([])
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
            <div style={{fontSize:12,color:C.inkFaint,padding:'8px 0'}}>No TWAIN devices found. Make sure your scanner is connected and its driver is installed.</div>
          )}
          {!loading&&devices.map(d=>(
            <div key={d.ID} className="flex items-center gap-2 px-3 py-2 rounded" style={{backgroundColor:C.paperDeep,border:`1px solid ${C.ruleSoft}`}}>
              <ScanLine size={13} style={{color:C.ochre,flexShrink:0}}/>
              <span className="sans flex-1" style={{fontSize:13,color:C.ink}}>{d.Name}</span>
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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App(){
  const [rootPath,setRootPath]             = useState('Z:\\')
  const [clients,setClients]               = useState<string[]>([])
  const [selectedClient,setSelectedClient] = useState<string|null>(null)
  const [docTree,setDocTree]               = useState<(DocFile|DocFolder)[]>([])
  const [expandedFolders,setExpandedFolders] = useState<Set<string>>(new Set())
  const [loadedFolderPaths,setLoadedFolderPaths] = useState<Set<string>>(new Set())
  const [selectedFile,setSelectedFile]     = useState<DocFile|null>(null)
  const [pdfBytes,setPdfBytes]             = useState<ArrayBuffer|null>(null)
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
  const [ctxFolder,setCtxFolder]           = useState<{x:number;y:number;folder:DocFolder}|null>(null)
  const [renaming,setRenaming]             = useState<{file:DocFile;value:string}|null>(null)
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
  const author='BC'

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

  // Mouse wheel: when scrolled to the bottom/top of the page, advance/retreat pages
  const handlePdfWheel=useCallback((e:React.WheelEvent<HTMLDivElement>)=>{
    const el=pdfScrollRef.current
    if(!el) return
    const atBottom = el.scrollTop+el.clientHeight >= el.scrollHeight-2
    const atTop = el.scrollTop<=2
    if(e.deltaY>0 && atBottom && currentPage<pageCount){
      if(wheelLockRef.current) return
      wheelLockRef.current=true
      setCurrentPage(p=>Math.min(pageCount,p+1))
      el.scrollTo({top:0})
      setTimeout(()=>{wheelLockRef.current=false},400)
    } else if(e.deltaY<0 && atTop && currentPage>1){
      if(wheelLockRef.current) return
      wheelLockRef.current=true
      setCurrentPage(p=>Math.max(1,p-1))
      setTimeout(()=>{
        const el2=pdfScrollRef.current
        if(el2) el2.scrollTo({top:el2.scrollHeight})
        wheelLockRef.current=false
      },50)
    }
  },[currentPage,pageCount])

  // Load PDF + annotations when file selected
  useEffect(()=>{
    if(!api||!selectedFile) return
    // Use pending page from bookmark click, otherwise start at page 1
    const startPage = pendingPageRef.current ?? 1
    pendingPageRef.current = null
    setCurrentPage(startPage)
    pdfScrollRef.current?.scrollTo({top:0})
    setAnnotations({tickmarks:[],signoffs:[]})
    api.readPdf(selectedFile.path).then(setPdfBytes)
    api.getAnnotations(selectedFile.path).then(setAnnotations)
  },[selectedFile])

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
    api?.onScanFile(({name})=>{
      setScanning(false); setScanPage(0)
      const id=crypto.randomUUID()
      setScanToasts(prev=>[...prev,{id,name}])
      setTimeout(()=>setScanToasts(prev=>prev.filter(t=>t.id!==id)),5000)
      refreshDocsRef.current(300)
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
    if(p){setRootPath(p);setSelectedClient(null);setSelectedFile(null)}
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
    for(const fp of filesToMove){
      const r=await api.moveFile(fp,destFolder)
      if(!r.ok) errors.push(r.error??fp)
    }
    if(errors.length) alert(`Some files could not be moved:\n${errors.join('\n')}`)
    if(filesToMove.includes(selectedFile?.path??'')) setSelectedFile(null)
    setMultiSelect([])
    refreshDocs(800)
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
    if(!api||!pdfBytes) return
    try{
      const {PDFDocument}=await import('pdf-lib')
      const src=await PDFDocument.load(pdfBytes)
      const doc=await PDFDocument.create()
      const [pg]=await doc.copyPages(src,[currentPage-1])
      doc.addPage(pg)
      const saved=await doc.save({useObjectStreams:false})
      const buf=saved.buffer.slice(saved.byteOffset,saved.byteOffset+saved.byteLength)
      const r=await api.printBytes(buf)
      if(!r.ok) alert('Print failed: '+(r.error??''))
    }catch(e){alert('Print failed: '+String(e))}
  }

  async function handleCombine(){
    if(!api||!selectedFile||!fileAbove) return
    const ok=window.confirm(`Combine:\n  ${fileAbove.name}\n+ ${selectedFile.name}\n\nThe top file will contain both documents. The bottom file will be deleted.`)
    if(!ok) return
    const result=await api.combineFiles(fileAbove.path,selectedFile.path)
    if(result.ok){
      setSelectedFile(null); setPdfBytes(null)
      refreshDocs(500)
    } else {
      alert(result.error??'Combine failed')
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
              onClick={()=>toggleFolder(node.path)}
              onContextMenu={e=>{e.preventDefault();e.stopPropagation();setCtxFolder({x:e.clientX,y:e.clientY,folder:node})}}
              onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(node.path)}}
              onDragLeave={e=>{e.stopPropagation();setDragOver(null)}}
              onDrop={e=>{e.preventDefault();e.stopPropagation();handleDrop(node.path)}}
            >
              <span style={{fontSize:15,fontWeight:700,color:C.inkMuted,width:14,display:'inline-block',textAlign:'center',lineHeight:1,flexShrink:0}}>{open?'−':'+'}</span>
              {open?<FolderOpen size={14} style={{color:isDrop?C.ochreDeep:C.ochre,flexShrink:0}}/>:<FolderClosed size={14} style={{color:isDrop?C.ochreDeep:C.ochre,flexShrink:0}}/>}
              <span className="serif" style={{fontSize:14,fontWeight:600,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{node.name}</span>
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
              } else { setMultiSelect([]); setSelectedFile(node) }
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
            <FileText size={13} style={{color:isActive?C.ochre:C.inkFaint,flexShrink:0}}/>
            <span className="flex-1 truncate sans" style={{fontSize:14,color:isActive?C.ink:C.inkSoft,fontWeight:isActive?600:400,marginLeft:3}}>{node.name}</span>
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
          <div style={{width:18,height:18,backgroundColor:C.ochre,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,color:C.ink}}>{author}</div>
          <div style={{width:1,height:14,backgroundColor:C.inkSoft}}/>
          <button onClick={()=>api?.minimizeWindow()} title="Minimize" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:C.inkFaint}} className="row-hover">─</button>
          <button onClick={()=>api?.maximizeWindow()} title="Maximize" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:C.inkFaint}} className="row-hover">□</button>
          <button onClick={()=>api?.closeWindow()} title="Close" style={{width:22,height:22,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:3,color:'#B5443A',fontWeight:700}} className="row-hover">✕</button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">

        {/* ── Left rail ── */}
        {leftOpen?(
          <div className="flex flex-col flex-shrink-0" style={{width:240,backgroundColor:C.paperLight,borderRight:`1px solid ${C.rule}`}}>
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
                      setSelectedClient(null);setSelectedFile(null);setDocTree([]);setExpandedFolders(new Set());setLoadedFolderPaths(new Set())
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
                  <div className="px-3 py-2 flex items-center justify-between" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
                    <div className="serif" style={{fontSize:10,letterSpacing:1.2,textTransform:'uppercase',color:C.inkMuted,fontWeight:600}}>Clients</div>
                    <div className="mono" style={{fontSize:9,color:C.inkFaint}}>{clients.length}</div>
                  </div>
                  {!api&&<div className="px-3 py-4 text-center" style={{color:C.inkMuted,fontSize:10}}>Running in browser — no filesystem access.<br/>Launch as Electron app to browse Z:\</div>}
                  {filteredClients.map(name=>{
                    const isSel=selectedClient===name
                    return(
                      <div key={name} className="flex items-center gap-2 px-3 py-2 cursor-pointer relative row-hover" style={{backgroundColor:isSel?C.ochreSoft:'transparent'}} onClick={()=>{setSelectedClient(name);setSearch('')}}>

                        {isSel&&<div className="absolute left-0 top-0 bottom-0" style={{width:2,backgroundColor:C.ochre}}/>}
                        <div style={{width:22,height:22,backgroundColor:isSel?C.ochre:C.paper,border:`1px solid ${isSel?C.ochre:C.rule}`,borderRadius:2,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          <span className="serif" style={{fontSize:11,fontWeight:600,color:isSel?C.ink:C.inkSoft}}>{name[0].toUpperCase()}</span>
                        </div>
                        <span className="flex-1 truncate sans" style={{fontSize:14,fontWeight:isSel?600:500,color:C.ink}}>{name}</span>
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
              <span className="mono" style={{fontSize:9,color:C.inkFaint}}>v0.1.0</span>
            </div>
          </div>
        ):(
          <button onClick={()=>setLeftOpen(true)} className="px-2 flex items-center row-hover" style={{backgroundColor:C.paperLight,borderRight:`1px solid ${C.rule}`,color:C.inkMuted}}><PanelLeftOpen size={14}/></button>
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

            {/* Combine with file above */}
            <button
              className="tool-btn sans"
              style={{color:fileAbove?C.inkSoft:'#bbb'}}
              disabled={!fileAbove}
              onClick={handleCombine}
              title={fileAbove?`Combine with: ${fileAbove.name}`:'Select a file to enable'}
            >
              <Merge size={14} style={{color:fileAbove?C.ochre:'#bbb'}}/> Combine with Above
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

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Tape toggle */}
            <button onClick={()=>setShowCalculator(s=>!s)} className="tool-btn sans" style={{color:showCalculator?C.ochreDeep:C.inkSoft,backgroundColor:showCalculator?C.ochreSoft:'transparent',border:`1px solid ${showCalculator?C.ochreLight:'transparent'}`}}>
              🧮 Tape
            </button>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* PDF area */}
            <div ref={pdfScrollRef} onWheel={handlePdfWheel} className="flex-1 overflow-auto p-6 scrollbar-thin" style={{backgroundColor:C.paperDeep}}>
              <div className="mx-auto doc-shadow" style={{width:'fit-content'}}>
                <PdfViewer pdfBytes={pdfBytes} zoom={zoom} page={currentPage} onPageCount={setPageCount} onPageSize={(w,h)=>setPageSize({w,h})} annotations={annotations} activeMark={activeMark} onAddTickmark={addTickmark} onAddTapeStamp={addTapeStamp} onDeleteTapeStamp={deleteTapeStamp} onMoveTapeStamp={moveTapeStamp} author={author}/>
              </div>
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
              {selectedClient&&<span className="mono" style={{color:C.inkFaint}}><span style={{color:C.ochreLight}}>TaxDome</span> {selectedClient}</span>}
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
          <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink}}
            onClick={()=>{setEditFolderModal(ctxFolder.folder);setCtxFolder(null)}}>
            🗂️ <span>Edit Folder…</span>
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
        <EditFileModal file={editFileModal} onClose={()=>setEditFileModal(null)} onSaved={()=>{
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
        <ScanDestModal clients={clients} rootPath={rootPath} onClose={()=>setShowScanModal(false)} onStarted={()=>setScanning(true)} onFailed={()=>setScanning(false)}/>
      )}

      {/* ── Scan settings modal ── */}
      {showScanSettings&&(
        <ScanSettingsModal onClose={()=>setShowScanSettings(false)}/>
      )}

      {/* ── Scan toasts ── */}
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
