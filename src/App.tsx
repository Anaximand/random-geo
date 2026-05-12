import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { flushSync } from 'react-dom'
import './App.css'

const centerModules = import.meta.glob('./assets/10x10/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

const centers = Object.entries(centerModules)
  .sort(([firstPath], [secondPath]) => firstPath.localeCompare(secondPath))
  .map(([, src]) => src as string)

type Tile = {
  id: string
  assetIndex: number
  src: string
  rotation: number
}

type Size = {
  width: number
  height: number
}

type Marker = {
  tileId: string
  x: number
  y: number
}

type DragPosition = {
  x: number
  y: number
}

type PanStart = {
  pointerId: number
  clientX: number
  clientY: number
  panX: number
  panY: number
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

type SavedDungeon = {
  v: 1
  w: number
  h: number
  t: Array<[number, number, string]>
  m: [string, number, number] | null
}

const MIN_SIZE = 1
const MAX_SIZE = 12
const EXPORT_TILE_SIZE = 512
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.1

function createRandom(seed: number) {
  let value = seed || 1

  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

function clampSize(value: number) {
  if (Number.isNaN(value)) {
    return MIN_SIZE
  }

  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, value))
}

function pickIndex(pool: string[], random: () => number) {
  return Math.floor(random() * pool.length)
}

function clampPercent(value: number) {
  return Math.min(1, Math.max(0, value))
}

function rotatePoint(x: number, y: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const centeredX = x - 0.5
  const centeredY = y - 0.5

  return {
    x: clampPercent(centeredX * cos - centeredY * sin + 0.5),
    y: clampPercent(centeredX * sin + centeredY * cos + 0.5),
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load image: ${src}`))
    image.src = src
  })
}

function buildTiles(size: Size, seed: number): Tile[] {
  const random = createRandom(seed)
  const tiles: Tile[] = []

  for (let row = 0; row < size.height; row += 1) {
    for (let column = 0; column < size.width; column += 1) {
      const assetIndex = pickIndex(centers, random)

      tiles.push({
        id: `${seed}-${column}-${row}`,
        assetIndex,
        src: centers[assetIndex],
        rotation: 0,
      })
    }
  }

  return tiles
}

function encodeDungeon(size: Size, tiles: Tile[], marker: Marker | null) {
  const savedDungeon: SavedDungeon = {
    v: 1,
    w: size.width,
    h: size.height,
    t: tiles.map((tile) => [
      tile.assetIndex,
      ((tile.rotation % 360) + 360) % 360,
      tile.id,
    ]),
    m: marker ? [marker.tileId, marker.x, marker.y] : null,
  }
  const json = JSON.stringify(savedDungeon)
  const encoded = btoa(json)

  return encoded.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeDungeon(
  value: string,
): { size: Size; tiles: Tile[]; marker: Marker | null } | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const parsed = JSON.parse(atob(padded)) as Partial<SavedDungeon>

    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.w) ||
      !Number.isInteger(parsed.h) ||
      !Array.isArray(parsed.t)
    ) {
      return null
    }

    const size = {
      width: clampSize(Number(parsed.w)),
      height: clampSize(Number(parsed.h)),
    }

    if (parsed.t.length !== size.width * size.height) {
      return null
    }

    const tiles = parsed.t.map((savedTile, index) => {
      if (!Array.isArray(savedTile)) {
        throw new Error('Invalid tile')
      }

      const [assetIndex, rotation, id] = savedTile

      if (
        !Number.isInteger(assetIndex) ||
        assetIndex < 0 ||
        assetIndex >= centers.length ||
        !Number.isFinite(rotation) ||
        typeof id !== 'string'
      ) {
        throw new Error('Invalid tile')
      }

      return {
        id: id || `saved-${index}`,
        assetIndex,
        src: centers[assetIndex],
        rotation,
      }
    })

    const marker =
      Array.isArray(parsed.m) &&
      typeof parsed.m[0] === 'string' &&
      Number.isFinite(parsed.m[1]) &&
      Number.isFinite(parsed.m[2]) &&
      tiles.some((tile) => tile.id === parsed.m?.[0])
        ? {
            tileId: parsed.m[0],
            x: clampPercent(parsed.m[1]),
            y: clampPercent(parsed.m[2]),
          }
        : null

    return { size, tiles, marker }
  } catch {
    return null
  }
}

function getInitialDungeon() {
  const savedDungeon = new URLSearchParams(window.location.search).get('d')

  if (savedDungeon) {
    const decodedDungeon = decodeDungeon(savedDungeon)

    if (decodedDungeon) {
      return decodedDungeon
    }
  }

  const size = { width: 3, height: 3 }

  return {
    size,
    tiles: buildTiles(size, Date.now()),
    marker: null,
  }
}

function withTransition(callback: () => void) {
  const transitionDocument = document as ViewTransitionDocument

  if (transitionDocument.startViewTransition) {
    transitionDocument.startViewTransition(() => {
      flushSync(callback)
    })
    return
  }

  callback()
}

function App() {
  const [initialDungeon] = useState(getInitialDungeon)
  const [size, setSize] = useState<Size>(() => initialDungeon.size)
  const [tiles, setTiles] = useState(() => initialDungeon.tiles)
  const [marker, setMarker] = useState<Marker | null>(
    () => initialDungeon.marker,
  )
  const [dragPosition, setDragPosition] = useState<DragPosition | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const isDraggingMarker = useRef(false)
  const panStart = useRef<PanStart | null>(null)
  const suppressTileClick = useRef(false)
  const zoomRef = useRef(zoom)

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('d', encodeDungeon(size, tiles, marker))

    const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`
    window.history.replaceState(null, '', nextUrl)
  }, [marker, size, tiles])

  useEffect(() => {
    if (!dragPosition) {
      return
    }

    function handlePointerMove(event: globalThis.PointerEvent) {
      if (!isDraggingMarker.current) {
        return
      }

      setDragPosition({ x: event.clientX, y: event.clientY })
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      if (!isDraggingMarker.current) {
        return
      }

      isDraggingMarker.current = false
      setDragPosition(null)

      const tileButton = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLButtonElement>('.tile-button')
      const tileId = tileButton?.dataset.tileId
      const tile = tiles.find((currentTile) => currentTile.id === tileId)

      if (!tileButton || !tileId || !tile) {
        setMarker(null)
        return
      }

      const rect = tileButton.getBoundingClientRect()
      const displayX = clampPercent((event.clientX - rect.left) / rect.width)
      const displayY = clampPercent((event.clientY - rect.top) / rect.height)
      const localPoint = rotatePoint(displayX, displayY, -tile.rotation)

      setMarker({
        tileId,
        x: localPoint.x,
        y: localPoint.y,
      })
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [dragPosition, tiles])

  function updateSize(field: keyof Size, value: string) {
    const nextSize = {
      ...size,
      [field]: clampSize(Number.parseInt(value, 10)),
    }

    setSize(nextSize)
    setTiles(buildTiles(nextSize, Date.now()))
    setMarker(null)
    setPan({ x: 0, y: 0 })
  }

  function regenerate() {
    withTransition(() => {
      setTiles(buildTiles(size, Date.now()))
      setMarker(null)
      setPan({ x: 0, y: 0 })
    })
  }

  function rotateTile(tileId: string) {
    if (suppressTileClick.current) {
      suppressTileClick.current = false
      return
    }

    setTiles((currentTiles) =>
      currentTiles.map((tile) =>
        tile.id === tileId
          ? { ...tile, rotation: tile.rotation + 90 }
          : tile,
      ),
    )
  }

  function startMarkerDrag(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    isDraggingMarker.current = true
    setDragPosition({ x: event.clientX, y: event.clientY })
  }

  function updateZoom(nextZoom: number) {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom)))
  }

  function zoomAtCursor(event: WheelEvent<HTMLElement>) {
    event.preventDefault()

    const currentZoom = zoomRef.current
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, currentZoom * Math.exp(-event.deltaY * 0.001)),
    )

    if (nextZoom === currentZoom) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const cursorX = event.clientX - (rect.left + rect.width / 2)
    const cursorY = event.clientY - (rect.top + rect.height / 2)
    const zoomRatio = nextZoom / currentZoom

    setPan((currentPan) => ({
      x: cursorX - (cursorX - currentPan.x) * zoomRatio,
      y: cursorY - (cursorY - currentPan.y) * zoomRatio,
    }))
    setZoom(nextZoom)
    zoomRef.current = nextZoom
  }

  function startPan(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || isDraggingMarker.current) {
      return
    }

    const target = event.target as HTMLElement

    if (
      target.closest(
        '.shift-button, .marker-source, .marker-on-tile, .site-footer',
      )
    ) {
      return
    }

    panStart.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    suppressTileClick.current = false
    setIsPanning(true)
  }

  function movePan(event: PointerEvent<HTMLElement>) {
    const currentPanStart = panStart.current

    if (!currentPanStart || currentPanStart.pointerId !== event.pointerId) {
      return
    }

    const movementX = event.clientX - currentPanStart.clientX
    const movementY = event.clientY - currentPanStart.clientY

    if (Math.hypot(movementX, movementY) > 4) {
      suppressTileClick.current = true
    }

    setPan({
      x: currentPanStart.panX + movementX,
      y: currentPanStart.panY + movementY,
    })
  }

  function stopPan(event: PointerEvent<HTMLElement>) {
    if (panStart.current?.pointerId !== event.pointerId) {
      return
    }

    panStart.current = null
    setIsPanning(false)
  }

  function shiftRow(row: number, direction: -1 | 1) {
    withTransition(() => {
      setTiles((currentTiles) => {
        const nextTiles = [...currentTiles]
        const start = row * size.width
        const rowTiles = nextTiles.slice(start, start + size.width)
        const shifted =
          direction === 1
            ? [rowTiles[rowTiles.length - 1], ...rowTiles.slice(0, -1)]
            : [...rowTiles.slice(1), rowTiles[0]]

        nextTiles.splice(start, size.width, ...shifted)
        return nextTiles
      })
    })
  }

  function shiftColumn(column: number, direction: -1 | 1) {
    withTransition(() => {
      setTiles((currentTiles) => {
        const nextTiles = [...currentTiles]
        const columnTiles = Array.from(
          { length: size.height },
          (_, row) => currentTiles[row * size.width + column],
        )
        const shifted =
          direction === 1
            ? [
                columnTiles[columnTiles.length - 1],
                ...columnTiles.slice(0, -1),
              ]
            : [...columnTiles.slice(1), columnTiles[0]]

        shifted.forEach((tile, row) => {
          nextTiles[row * size.width + column] = tile
        })

        return nextTiles
      })
    })
  }

  async function exportDungeonPng() {
    setIsExporting(true)

    try {
      const canvas = document.createElement('canvas')
      canvas.width = size.width * EXPORT_TILE_SIZE
      canvas.height = size.height * EXPORT_TILE_SIZE

      const context = canvas.getContext('2d')

      if (!context) {
        return
      }

      context.imageSmoothingEnabled = false
      context.fillStyle = '#e8e1d3'
      context.fillRect(0, 0, canvas.width, canvas.height)

      const loadedImages = await Promise.all(
        tiles.map((tile) => loadImage(tile.src)),
      )

      tiles.forEach((tile, index) => {
        const column = index % size.width
        const row = Math.floor(index / size.width)
        const x = column * EXPORT_TILE_SIZE
        const y = row * EXPORT_TILE_SIZE

        context.save()
        context.translate(x + EXPORT_TILE_SIZE / 2, y + EXPORT_TILE_SIZE / 2)
        context.rotate((tile.rotation * Math.PI) / 180)
        context.drawImage(
          loadedImages[index],
          -EXPORT_TILE_SIZE / 2,
          -EXPORT_TILE_SIZE / 2,
          EXPORT_TILE_SIZE,
          EXPORT_TILE_SIZE,
        )

        if (marker?.tileId === tile.id) {
          const markerRadius = Math.max(8, Math.min(18, EXPORT_TILE_SIZE * 0.035))
          const markerX = marker.x * EXPORT_TILE_SIZE - EXPORT_TILE_SIZE / 2
          const markerY = marker.y * EXPORT_TILE_SIZE - EXPORT_TILE_SIZE / 2

          context.beginPath()
          context.arc(markerX, markerY, markerRadius, 0, Math.PI * 2)
          context.fillStyle = '#7b2ff2'
          context.fill()
          context.lineWidth = Math.max(3, markerRadius * 0.25)
          context.strokeStyle = '#ffffff'
          context.stroke()
        }

        context.restore()
      })

      canvas.toBlob((blob) => {
        if (!blob) {
          return
        }

        const objectUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = 'dynamic-geomorph-dungeon.png'
        link.click()
        URL.revokeObjectURL(objectUrl)
      }, 'image/png')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="control-panel" aria-labelledby="app-title">
        <h1 id="app-title">Dynamic Geomorph Dungeon</h1>

        <div className="size-controls" aria-label="Composition size">
          <label>
            <span>Width</span>
            <input
              type="number"
              min={MIN_SIZE}
              max={MAX_SIZE}
              value={size.width}
              onChange={(event) => updateSize('width', event.target.value)}
            />
          </label>
          <label>
            <span>Height</span>
            <input
              type="number"
              min={MIN_SIZE}
              max={MAX_SIZE}
              value={size.height}
              onChange={(event) => updateSize('height', event.target.value)}
            />
          </label>
          <button type="button" onClick={regenerate}>
            Generate
          </button>
          <button
            type="button"
            className="secondary-action"
            disabled={isExporting}
            onClick={() => void exportDungeonPng()}
          >
            {isExporting ? 'Saving...' : 'Save PNG'}
          </button>
        </div>

        <div className="marker-panel">
          <button
            type="button"
            className="marker-source"
            aria-label="Drag tracking marker onto a geomorph"
            onPointerDown={startMarkerDrag}
          >
            <span className="marker-dot" aria-hidden="true"></span>
          </button>
          <span>Drag the party onto the map.</span>
        </div>

        <div className="zoom-controls" aria-label="Map zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => updateZoom(zoom - ZOOM_STEP)}
          >
            -
          </button>
          <label>
            <span>Zoom</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step="0.05"
              value={zoom}
              onChange={(event) => updateZoom(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => updateZoom(zoom + ZOOM_STEP)}
          >
            +
          </button>
        </div>
      </section>

      <section
        className={`composition-stage ${isPanning ? 'is-panning' : ''}`}
        aria-label="Generated geomorph map"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
        onWheel={zoomAtCursor}
      >
        <div
          className="board-controls"
          style={
            {
              '--map-width': size.width,
              '--map-height': size.height,
              '--zoom': zoom,
              '--pan-x': `${pan.x}px`,
              '--pan-y': `${pan.y}px`,
            } as CSSProperties
          }
        >
          <div className="column-controls top-controls">
            {Array.from({ length: size.width }, (_, column) => (
              <button
                key={`up-${column}`}
                type="button"
                className="shift-button"
                title={`Shift column ${column + 1} up`}
                aria-label={`Shift column ${column + 1} up`}
                onClick={() => shiftColumn(column, -1)}
              >
                <span aria-hidden="true">^</span>
              </button>
            ))}
          </div>

          <div className="row-controls left-controls">
            {Array.from({ length: size.height }, (_, row) => (
              <button
                key={`left-${row}`}
                type="button"
                className="shift-button"
                title={`Shift row ${row + 1} left`}
                aria-label={`Shift row ${row + 1} left`}
                onClick={() => shiftRow(row, -1)}
              >
                <span aria-hidden="true">&lt;</span>
              </button>
            ))}
          </div>

          <div
            className="geomorph-grid"
            style={
              {
                gridTemplateColumns: `repeat(${size.width}, minmax(0, 1fr))`,
              } as CSSProperties
            }
          >
            {tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                className="tile-button"
                data-tile-id={tile.id}
                aria-label="Rotate geomorph clockwise"
                onClick={() => rotateTile(tile.id)}
                style={
                  {
                    viewTransitionName: `tile-${tile.id}`,
                  } as CSSProperties
                }
              >
                <span
                  className="tile-content"
                  style={{ transform: `rotate(${tile.rotation}deg)` }}
                >
                  <img className="tile" src={tile.src} alt="" />
                  {marker?.tileId === tile.id && !dragPosition ? (
                    <span
                      className="marker-dot marker-on-tile"
                      aria-hidden="true"
                      onPointerDown={startMarkerDrag}
                      onClick={(event) => event.stopPropagation()}
                      style={{
                        left: `${marker.x * 100}%`,
                        top: `${marker.y * 100}%`,
                      }}
                    ></span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="row-controls right-controls">
            {Array.from({ length: size.height }, (_, row) => (
              <button
                key={`right-${row}`}
                type="button"
                className="shift-button"
                title={`Shift row ${row + 1} right`}
                aria-label={`Shift row ${row + 1} right`}
                onClick={() => shiftRow(row, 1)}
              >
                <span aria-hidden="true">&gt;</span>
              </button>
            ))}
          </div>

          <div className="column-controls bottom-controls">
            {Array.from({ length: size.width }, (_, column) => (
              <button
                key={`down-${column}`}
                type="button"
                className="shift-button"
                title={`Shift column ${column + 1} down`}
                aria-label={`Shift column ${column + 1} down`}
                onClick={() => shiftColumn(column, 1)}
              >
                <span aria-hidden="true">v</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {dragPosition ? (
        <span
          className="marker-dot marker-floating"
          aria-hidden="true"
          style={{
            left: dragPosition.x,
            top: dragPosition.y,
          }}
        ></span>
      ) : null}

      <footer className="site-footer">
        Geomorph images by SoaringMoon, taken from{' '}
        <a href="https://soaringmoon.itch.io/infinite-floorplanner">
          Infinite Floorplanner
        </a>
        .
      </footer>
    </main>
  )
}

export default App
