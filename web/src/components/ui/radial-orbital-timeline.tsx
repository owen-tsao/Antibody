import { useEffect, useRef, useState } from "react";

import { MetalFrame } from "@/components/ui/liquid-metal-border";
import { useMotionPref } from "@/hooks/useMotionPref";
import { cn } from "@/lib/utils";

/**
 * Owen's `radial-orbital-timeline` (component-library, `prompts/radial-orbital-timeline-integration.md`), ported
 * with its orbit intact: nodes circle a core at radius 200, auto-rotating 0.3° every 50 ms; clicking a node stops
 * the rotation, turns it to the front (270° − its angle), scales it up and pulses its related nodes; clicking the
 * empty orbit resets. Changes from the paste: the purple→teal core is the app's liquid-metal chrome (`MetalFrame`)
 * and so is every node — a 28 px ring holding the host's `avatar` (a photo turned to a hue: the agent's tile) or,
 * with none, a plain chrome orb — dimmed when `paused`, a dot at its edge when `running`; the label beneath is two
 * lines, `title` then `date`; the in-place detail card is gone — a click reports the node through `onSelect` and
 * the host opens its own dialog, which `selectedId` keeps in step (null from outside = reset); the field has no
 * background or frame of its own (it floats on the page); and reduced motion stops the auto-rotation.
 */

export interface TimelineItem {
  id: number;
  /** First line under the node. */
  title: string;
  /** Second line under the node. */
  date: string;
  /** The picture inside the ring — an image and the CSS `hue-rotate` (degrees) that colours it; null draws a plain orb. */
  avatar: { src: string; hue: number } | null;
  relatedIds: number[];
  status: "paused" | "running" | "waiting";
  energy: number;
}

interface RadialOrbitalTimelineProps {
  timelineData: TimelineItem[];
  /** The node the host is showing (its dialog); null clears the selection here too. */
  selectedId?: number | null;
  onSelect?: (item: TimelineItem | null) => void;
  className?: string;
  children?: React.ReactNode;
}

export default function RadialOrbitalTimeline({ timelineData, selectedId, onSelect, className, children }: RadialOrbitalTimelineProps) {
  const reduced = useMotionPref();
  const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({});
  const [viewMode] = useState<"orbital">("orbital");
  const [rotationAngle, setRotationAngle] = useState<number>(0);
  const [autoRotate, setAutoRotate] = useState<boolean>(true);
  const [pulseEffect, setPulseEffect] = useState<Record<number, boolean>>({});
  const [centerOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [activeNodeId, setActiveNodeId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const reset = () => {
    setExpandedItems({});
    setActiveNodeId(null);
    setPulseEffect({});
    setAutoRotate(true);
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === containerRef.current || e.target === orbitRef.current) {
      reset();
      onSelect?.(null);
    }
  };

  // The host closed its dialog: the orbit lets go too. Tracked during render, guarded, the way the app's other
  // "follow a prop" states are — so it settles in one pass and never loops.
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (selectedId !== seenSelected) {
    setSeenSelected(selectedId);
    if (selectedId === null && activeNodeId !== null) reset();
  }

  // Reads `expandedItems` from render rather than the updater's `prev`: the setters and `onSelect` must run outside
  // the updater (React runs updaters twice under StrictMode, and the host's dialog would open twice).
  const toggleItem = (id: number) => {
    const opening = !expandedItems[id];
    const newState: Record<number, boolean> = {};
    Object.keys(expandedItems).forEach((key) => {
      newState[parseInt(key)] = false;
    });
    newState[id] = opening;
    setExpandedItems(newState);

    if (opening) {
      setActiveNodeId(id);
      setAutoRotate(false);

      const relatedItems = getRelatedItems(id);
      const newPulseEffect: Record<number, boolean> = {};
      relatedItems.forEach((relId) => {
        newPulseEffect[relId] = true;
      });
      setPulseEffect(newPulseEffect);

      centerViewOnNode(id);
      onSelect?.(timelineData.find((item) => item.id === id) ?? null);
    } else {
      setActiveNodeId(null);
      setAutoRotate(true);
      setPulseEffect({});
      onSelect?.(null);
    }
  };

  useEffect(() => {
    let rotationTimer: ReturnType<typeof setInterval> | undefined;

    if (autoRotate && viewMode === "orbital" && !reduced) {
      rotationTimer = setInterval(() => {
        setRotationAngle((prev) => {
          const newAngle = (prev + 0.3) % 360;
          return Number(newAngle.toFixed(3));
        });
      }, 50);
    }

    return () => {
      if (rotationTimer) {
        clearInterval(rotationTimer);
      }
    };
  }, [autoRotate, viewMode, reduced]);

  const centerViewOnNode = (nodeId: number) => {
    if (viewMode !== "orbital" || !nodeRefs.current[nodeId]) return;

    const nodeIndex = timelineData.findIndex((item) => item.id === nodeId);
    const totalNodes = timelineData.length;
    const targetAngle = (nodeIndex / totalNodes) * 360;

    setRotationAngle(270 - targetAngle);
  };

  const calculateNodePosition = (index: number, total: number) => {
    const angle = ((index / total) * 360 + rotationAngle) % 360;
    const radius = 200;
    const radian = (angle * Math.PI) / 180;

    const x = radius * Math.cos(radian) + centerOffset.x;
    const y = radius * Math.sin(radian) + centerOffset.y;

    const zIndex = Math.round(100 + 50 * Math.cos(radian));
    const opacity = Math.max(0.4, Math.min(1, 0.4 + 0.6 * ((1 + Math.sin(radian)) / 2)));

    return { x, y, angle, zIndex, opacity };
  };

  const getRelatedItems = (itemId: number): number[] => {
    const currentItem = timelineData.find((item) => item.id === itemId);
    return currentItem ? currentItem.relatedIds : [];
  };

  const isRelatedToActive = (itemId: number): boolean => {
    if (!activeNodeId) return false;
    const relatedItems = getRelatedItems(activeNodeId);
    return relatedItems.includes(itemId);
  };

  return (
    <div className={cn("relative flex w-full flex-col items-center justify-center overflow-hidden", className ?? "h-[560px]")} ref={containerRef} onClick={handleContainerClick}>
      <div className="absolute inset-0 mx-auto flex max-w-4xl items-center justify-center">
        <div
          className="absolute inset-0 flex items-center justify-center"
          ref={orbitRef}
          style={{
            perspective: "1000px",
            transform: `translate(${centerOffset.x}px, ${centerOffset.y}px)`,
          }}
        >
          <div className="absolute z-10 flex h-16 w-16 items-center justify-center rounded-full">
            <MetalFrame radius={9999} thickness={2.5} className="h-16 w-16" innerClassName="flex h-[calc(100%-5px)] items-center justify-center bg-black">
              <div className="h-8 w-8 rounded-full bg-white/80 backdrop-blur-md"></div>
            </MetalFrame>
          </div>

          <div className="absolute h-96 w-96 rounded-full border border-white/10"></div>

          {timelineData.map((item, index) => {
            const position = calculateNodePosition(index, timelineData.length);
            const isExpanded = expandedItems[item.id];
            const isRelated = isRelatedToActive(item.id);
            const isPulsing = pulseEffect[item.id];
            const paused = item.status === "paused";

            const nodeStyle = {
              transform: `translate(${position.x}px, ${position.y}px)`,
              zIndex: isExpanded ? 200 : position.zIndex,
              opacity: isExpanded ? 1 : position.opacity,
            };

            return (
              <div
                key={item.id}
                ref={(el) => {
                  nodeRefs.current[item.id] = el;
                }}
                className="absolute cursor-pointer transition-all duration-700"
                style={nodeStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleItem(item.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={`${item.title} · ${item.date}`}
                aria-pressed={!!isExpanded}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleItem(item.id);
                  }
                }}
              >
                <div
                  className={cn("absolute rounded-full", isPulsing && "animate-pulse duration-1000")}
                  style={{
                    background: `radial-gradient(circle, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 70%)`,
                    width: `${item.energy * 0.5 + 28}px`,
                    height: `${item.energy * 0.5 + 28}px`,
                    left: `-${(item.energy * 0.5) / 2}px`,
                    top: `-${(item.energy * 0.5) / 2}px`,
                  }}
                ></div>

                {/* The node: the core's chrome at 28 px around the avatar (the agent's photo, cropped as its tile is) or,
                    with none, an empty orb. Paused sits at 40 % behind a hairline ring; running carries a dot at the
                    rim; the picked one grows and its ring quickens, a related one pulses. */}
                <div className={cn("relative h-7 w-7 transition-transform duration-300", isExpanded && "scale-150", isRelated && "animate-pulse")}>
                  <MetalFrame radius={9999} thickness={1.5} active={isExpanded} className={cn("h-7 w-7", paused && "opacity-40")} innerClassName={cn("h-[calc(100%-3px)] overflow-hidden", isExpanded && !item.avatar ? "bg-white" : "bg-black")}>
                    {item.avatar && (
                      <img src={item.avatar.src} alt="" draggable={false} className="h-full w-full object-cover" style={{ objectPosition: "45% 50%", filter: `hue-rotate(${item.avatar.hue}deg)` }} />
                    )}
                  </MetalFrame>
                  {paused && <span aria-hidden className="absolute -inset-1 rounded-full border border-white/30" />}
                  {item.status === "running" && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-white ring-2 ring-black" />}
                </div>

                <div
                  className={cn(
                    "absolute left-1/2 top-9 -translate-x-1/2 text-center text-[11px] leading-[1.4] transition-all duration-300",
                    isExpanded && "scale-110",
                    paused && "opacity-40",
                  )}
                >
                  <span className={cn("block max-w-[160px] truncate", isExpanded ? "text-white" : "text-white/75")}>{item.title}</span>
                  <span className={cn("block max-w-[160px] truncate", isExpanded ? "text-white/60" : "text-white/45")}>{item.date}</span>
                </div>
              </div>
            );
          })}
        </div>
        {children}
      </div>
    </div>
  );
}
