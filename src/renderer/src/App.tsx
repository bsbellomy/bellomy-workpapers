import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, FolderOpen, FolderClosed, FileText, Check, X,
  ChevronRight, ChevronDown, FileSignature, ZoomIn, ZoomOut,
  MessageSquare, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen,
  Clock, Layers, Settings, ScanLine, ArrowLeft, Merge,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tickmark { id:string; page:number; x:number; y:number; type:string; note:string; author:string; createdAt:string }
interface Signoff  { page:number; role:string; author:string; signedAt:string }
interface Annotations { tickmarks:Tickmark[]; signoffs:Signoff[] }
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
  scan:           ()=>Promise<boolean>
  pickFolder:     ()=>Promise<string|null>
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

// ── PDF Viewer ────────────────────────────────────────────────────────────────

interface PdfViewerProps {
  pdfBytes:ArrayBuffer|null; zoom:number; page:number; onPageCount:(n:number)=>void
  annotations:Annotations; activeMark:string
  onAddTickmark:(t:Omit<Tickmark,'id'|'author'|'createdAt'>)=>void; author:string
}

function PdfViewer({pdfBytes,zoom,page,onPageCount,annotations,activeMark,onAddTickmark,author}:PdfViewerProps){
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
    // Cancel any in-flight render immediately (synchronous, before any await)
    renderTask.current?.cancel()
    renderTask.current=null
    const seq=++renderSeq.current
    async function renderPage(){
      const pdfPage=await pdfDoc.getPage(Math.min(page,pdfDoc.numPages))
      if(renderSeq.current!==seq) return // a newer render was requested
      const scale=zoom/100
      const viewport=pdfPage.getViewport({scale})
      const canvas=canvasRef.current; if(!canvas) return
      canvas.width=viewport.width; canvas.height=viewport.height
      const task=pdfPage.render({canvasContext:canvas.getContext('2d')!,viewport})
      renderTask.current=task
      await task.promise.catch(()=>{})
    }
    renderPage()
  },[pdfDoc,page,zoom])

  function handleClick(e:React.MouseEvent<HTMLDivElement>){
    const canvas=canvasRef.current; if(!canvas) return
    const rect=canvas.getBoundingClientRect()
    const x=((e.clientX-rect.left)/rect.width)*100
    const y=((e.clientY-rect.top)/rect.height)*100
    onAddTickmark({page,x,y,type:activeMark,note:author})
  }

  const pageAnns=annotations.tickmarks.filter(t=>t.page===page)
  const checkDefs:{[k:string]:{color:string}}=Object.fromEntries(CHECKS.map(c=>[c.id,{color:c.color}]))

  return(
    <div className="relative inline-block" style={{cursor:'crosshair'}} onClick={handleClick}>
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
  const inputRef=useRef<HTMLInputElement>(null)

  useEffect(()=>{inputRef.current?.focus()},[])
  useEffect(()=>{
    if(!api||!targetClient) return
    setLoading(true); setDestFolder(null)
    const cp=rootPath.replace(/\\$/,'')+`\\${targetClient}`
    api.listDocs(cp).then(tree=>{setFolderTree(tree);setDestFolder(cp);setLoading(false)})
  },[targetClient,rootPath])

  const filtered=clients.filter(c=>c.toLowerCase().includes(search.toLowerCase())).slice(0,60)

  function renderFolders(nodes:(DocFile|DocFolder)[],depth=0):React.ReactNode{
    return nodes.filter(n=>n.type==='folder').map(n=>{
      const f=n as DocFolder; const isSel=destFolder===f.path
      return(
        <div key={f.path}>
          <div className="flex items-center gap-2 cursor-pointer" style={{paddingLeft:12+depth*16,paddingTop:6,paddingBottom:6,paddingRight:12,backgroundColor:isSel?C.ochreSoft:'transparent',borderLeft:isSel?`3px solid ${C.ochre}`:'3px solid transparent',color:isSel?C.ochreDeep:C.inkSoft}} onClick={()=>setDestFolder(f.path)}>
            <FolderOpen size={13} style={{color:C.ochre,flexShrink:0}}/>
            <span className="sans truncate" style={{fontSize:13,fontWeight:isSel?600:400}}>{f.name}</span>
          </div>
          {renderFolders(f.children,depth+1)}
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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App(){
  const [rootPath,setRootPath]             = useState('Z:\\')
  const [clients,setClients]               = useState<string[]>([])
  const [selectedClient,setSelectedClient] = useState<string|null>(null)
  const [docTree,setDocTree]               = useState<(DocFile|DocFolder)[]>([])
  const [expandedFolders,setExpandedFolders] = useState<Set<string>>(new Set())
  const [selectedFile,setSelectedFile]     = useState<DocFile|null>(null)
  const [pdfBytes,setPdfBytes]             = useState<ArrayBuffer|null>(null)
  const [annotations,setAnnotations]       = useState<Annotations>({tickmarks:[],signoffs:[]})
  const [pageCount,setPageCount]           = useState(1)
  const [currentPage,setCurrentPage]       = useState(1)
  const [zoom,setZoom]                     = useState(100)
  const [activeMark,setActiveMark]         = useState('check')
  const [leftOpen,setLeftOpen]             = useState(true)
  const [rightOpen,setRightOpen]           = useState(true)
  const [rightTab,setRightTab]             = useState<'notes'|'xref'|'signoff'>('notes')
  const [showCalculator,setShowCalculator] = useState(false)
  const [search,setSearch]                 = useState('')
  const [dragSrc,setDragSrc]               = useState<string|null>(null)
  const [dragOver,setDragOver]             = useState<string|null>(null)
  const [ctxMenu,setCtxMenu]               = useState<{x:number;y:number;file:DocFile}|null>(null)
  const [renaming,setRenaming]             = useState<{file:DocFile;value:string}|null>(null)
  const [moveDrawer,setMoveDrawer]         = useState<DocFile[]|null>(null)
  const [multiSelect,setMultiSelect]       = useState<DocFile[]>([])
  // bookmarks: undefined = not checked, 'loading' = in progress, 'none' = no bookmarks, Bookmark[] = loaded
  const [fileBookmarks,setFileBookmarks]   = useState<Record<string,Bookmark[]|'loading'|'none'>>({})
  const [expandedBookmarks,setExpandedBookmarks] = useState<Set<string>>(new Set())
  const pendingPageRef = useRef<number|null>(null) // page to jump to after file loads
  const pdfScrollRef = useRef<HTMLDivElement|null>(null)
  const author='BC'

  // Load clients
  useEffect(()=>{
    if(!api) return
    api.listClients(rootPath).then(setClients)
  },[rootPath])

  // Load doc tree
  const refreshDocs=useCallback((delayMs=0)=>{
    if(!api||!selectedClient) return
    const cp=rootPath.replace(/\\$/,'')+`\\${selectedClient}`
    setTimeout(()=>{
      api!.listDocs(cp).then(tree=>{
        setDocTree(tree)
        setExpandedFolders(prev=>{
          if(prev.size===0) return new Set(tree.filter(n=>n.type==='folder').map(n=>n.path))
          return prev
        })
      })
    },delayMs)
  },[selectedClient,rootPath])

  useEffect(()=>{refreshDocs()},[refreshDocs])

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

  const addTickmark=useCallback((partial:Omit<Tickmark,'id'|'author'|'createdAt'>)=>{
    const tm:Tickmark={...partial,id:crypto.randomUUID(),author,createdAt:new Date().toISOString()}
    setAnnotations(prev=>{
      const next={...prev,tickmarks:[...prev.tickmarks,tm]}
      if(api&&selectedFile) api.saveAnnotations(selectedFile.path,next)
      return next
    })
  },[author,selectedFile])

  // Keyboard shortcuts
  useEffect(()=>{
    function onKey(e:KeyboardEvent){
      if(e.target instanceof HTMLInputElement) return
      if(e.key==='ArrowRight'||e.key==='PageDown') setCurrentPage(p=>Math.min(pageCount,p+1))
      if(e.key==='ArrowLeft' ||e.key==='PageUp')   setCurrentPage(p=>Math.max(1,p-1))
    }
    window.addEventListener('keydown',onKey)
    return()=>window.removeEventListener('keydown',onKey)
  },[pageCount])

  // Close context menu on click
  useEffect(()=>{
    const close=()=>setCtxMenu(null)
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

  function toggleFolder(p:string){
    setExpandedFolders(prev=>{const n=new Set(prev);n.has(p)?n.delete(p):n.add(p);return n})
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
              onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(node.path)}}
              onDragLeave={e=>{e.stopPropagation();setDragOver(null)}}
              onDrop={e=>{e.preventDefault();e.stopPropagation();handleDrop(node.path)}}
            >
              {open?<ChevronDown size={11}/>:<ChevronRight size={11}/>}
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
                  : bmOpen
                    ? <ChevronDown size={11}/>
                    : <ChevronRight size={11}/>
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
        .doc-shadow{box-shadow:0 1px 2px rgba(26,22,18,0.04),0 4px 12px rgba(26,22,18,0.06),0 16px 40px rgba(26,22,18,0.08)}
        .tool-btn{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid transparent;transition:all 0.12s}
        .tool-btn:hover{background:rgba(168,119,31,0.08);border-color:${C.ruleSoft}}
        .tool-btn:disabled{opacity:0.35;cursor:not-allowed}
      `}</style>

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-4 py-2 flex-shrink-0" style={{backgroundColor:C.ink,color:C.paperLight}}>
        <div className="flex items-center gap-3 min-w-0">
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
        <div className="flex items-center gap-3 text-[10px] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="pulse" style={{width:6,height:6,borderRadius:'50%',backgroundColor:'#7DBE5C'}}/>
            <span style={{color:C.inkFaint}}>Synced</span>
          </div>
          <div style={{height:14,width:1,backgroundColor:C.inkSoft}}/>
          <button onClick={pickFolder} style={{color:C.inkFaint}} title="Change root folder"><Settings size={11}/></button>
          <div style={{width:18,height:18,backgroundColor:C.ochre,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,color:C.ink}}>{author}</div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">

        {/* ── Left rail ── */}
        {leftOpen?(
          <div className="flex flex-col flex-shrink-0" style={{width:240,backgroundColor:C.paperLight,borderRight:`1px solid ${C.rule}`}}>
            <div className="px-3 py-2 flex items-center gap-1.5" style={{borderBottom:`1px solid ${C.ruleSoft}`}}>
              {selectedClient?(
                <button onClick={()=>{setSelectedClient(null);setSelectedFile(null);setDocTree([]);setExpandedFolders(new Set())}} className="flex items-center gap-1.5 flex-1 min-w-0" style={{color:C.inkMuted}}>
                  <ArrowLeft size={11}/>
                  <span className="serif truncate" style={{fontSize:12,fontWeight:600,color:C.ink}}>{selectedClient}</span>
                </button>
              ):(
                <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded" style={{backgroundColor:C.paper,border:`1px solid ${C.rule}`}}>
                  <Search size={11} style={{color:C.inkMuted}}/>
                  <input type="text" placeholder="Search clients…" value={search} onChange={e=>setSearch(e.target.value)} className="flex-1 outline-none text-[11px] bg-transparent min-w-0 sans" style={{color:C.ink}}/>
                </div>
              )}
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
                      <div key={name} className="flex items-center gap-2 px-3 py-2 cursor-pointer relative row-hover" style={{backgroundColor:isSel?C.ochreSoft:'transparent'}} onClick={()=>setSelectedClient(name)}>
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
            <button className="tool-btn sans" style={{color:C.inkSoft}} onClick={()=>api?.scan()} title="Launch scanner">
              <ScanLine size={14} style={{color:C.ochre}}/> Scan
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

            <div style={{width:1,height:18,backgroundColor:C.rule,margin:'0 4px'}}/>

            {/* Tape toggle */}
            <button onClick={()=>setShowCalculator(s=>!s)} className="tool-btn sans" style={{color:showCalculator?C.ochreDeep:C.inkSoft,backgroundColor:showCalculator?C.ochreSoft:'transparent',border:`1px solid ${showCalculator?C.ochreLight:'transparent'}`}}>
              🧮 Tape
            </button>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* PDF area */}
            <div ref={pdfScrollRef} className="flex-1 overflow-auto p-6 scrollbar-thin" style={{backgroundColor:C.paperDeep}}>
              <div className="mx-auto doc-shadow" style={{width:'fit-content'}}>
                <PdfViewer pdfBytes={pdfBytes} zoom={zoom} page={currentPage} onPageCount={setPageCount} annotations={annotations} activeMark={activeMark} onAddTickmark={addTickmark} author={author}/>
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
                      onClick={()=>setActiveMark(c.id)}
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

                {showCalculator&&(
                  <div style={{borderBottom:`1px solid ${C.rule}`}}>
                    <div className="px-3 py-1.5 flex items-center justify-between" style={{backgroundColor:C.ink,color:C.paperLight}}>
                      <span className="serif" style={{fontSize:10,fontWeight:600}}>Calculator Tape</span>
                      <button className="mono" style={{fontSize:9,color:C.inkFaint}}>clear</button>
                    </div>
                    <div className="p-2" style={{fontFamily:'JetBrains Mono,monospace',fontSize:10,backgroundColor:'#FEFCF7'}}>
                      <div style={{color:C.inkMuted,padding:'4px',borderBottom:`1px dotted ${C.rule}`,fontSize:9}}>Click numbers in PDF to add</div>
                      <div className="flex justify-between py-1.5 px-1 mt-1" style={{borderTop:`2px solid ${C.ink}`,backgroundColor:C.ochreSoft,fontWeight:700}}>
                        <span>Σ TOTAL</span><span>0.00</span>
                      </div>
                    </div>
                  </div>
                )}

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
                                <div className="serif" style={{fontSize:11,fontWeight:700,color:C.ink}}>{def.label}</div>
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
                                <div>
                                  <div className="sans" style={{fontSize:10,color:C.ink,fontWeight:600}}>{role}</div>
                                  <div className="mono" style={{fontSize:8,color:C.inkMuted}}>{so?`${so.author} · ${new Date(so.signedAt).toLocaleDateString()}`:'pending'}</div>
                                </div>
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
              <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink}} onClick={()=>{setRenaming({file:ctxMenu.file,value:ctxMenu.file.name.replace(/\.[^.]+$/,'')});setCtxMenu(null)}}>
                ✏️ <span>Rename</span>
              </button>
            )}
            <button className="w-full text-left px-4 py-2.5 sans row-hover flex items-center gap-2" style={{fontSize:13,color:C.ink,borderTop:isBulk?'none':`1px solid ${C.ruleSoft}`}} onClick={()=>{setMoveDrawer(affectedFiles);setCtxMenu(null)}}>
              📁 <span>{isBulk?`Move ${affectedFiles.length} files to Another Drawer`:'Move to Another Drawer'}</span>
            </button>
          </div>
        )
      })()}

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
    </div>
  )
}
