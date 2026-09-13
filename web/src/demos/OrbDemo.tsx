"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { type AgentState, Orb } from "@/components/ui/orb"

let ORBS: [string, string][] = [
  ["#CADCFC", "#A0B9D1"],
  ["#F6E7D8", "#E0CFC2"],
  ["#E5E7EB", "#9CA3AF"],
]

export default function OrbDemo({ small = false }: { small?: boolean }) {
  const [agent, setAgent] = useState<AgentState>(null)

  ORBS = small ? [ORBS[0]] : ORBS

  return (
    <div className="bg-card mx-auto w-full max-w-sm rounded-lg border p-6 shadow-sm sm:max-w-md md:max-w-lg">
      <div className="mb-4 text-center">
        <h3 className="text-lg font-semibold">Agent Orbs</h3>
        <p className="text-muted-foreground text-sm">
          Interactive orb visualization with agent states
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap justify-center gap-6">
          {ORBS.map((colors, index) => (
            <div
              key={index}
              className={`relative ${
                index === 1 ? "block md:block" : "hidden md:block"
              }`}
            >
              <div className="bg-muted relative h-28 w-28 rounded-full p-1 shadow-[inset_0_2px_8px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)] sm:h-32 sm:w-32">
                <div className="bg-background h-full w-full overflow-hidden rounded-full shadow-[inset_0_0_12px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_0_12px_rgba(0,0,0,0.3)]">
                  <Orb
                    colors={colors}
                    seed={(index + 1) * 1000}
                    agentState={agent}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAgent(null)}
            disabled={agent === null}
          >
            Idle
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAgent("listening")}
            disabled={agent === "listening"}
          >
            Listening
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={agent === "talking"}
            onClick={() => setAgent("talking")}
          >
            Talking
          </Button>
        </div>
      </div>
    </div>
  )
}
