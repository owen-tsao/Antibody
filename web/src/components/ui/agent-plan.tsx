"use client";

// Verbatim from 21st.dev (~/.cursor/skills/component-library/prompts/interactive-list-preview-and-agent-plan-integration.md)
// with three changes, per docs/FRONTEND.md §4.2:
//   1. `initialTasks` became a `tasks: Task[]` prop (the demo array stays as the default)
//   2. the two status-randomizing click handlers (toggleTaskStatus / toggleSubtaskStatus) are
//      removed — status is truth from the backend and clicking must not change it
//   3. the `MCP Servers:` label reads `tool calls:`
// Also exports `tasks`/`initialTasks` are dropped in favour of the prop; the `expandedTasks`
// initial state is derived from the first task instead of the hardcoded id "1".
// Type-only: variants are annotated `Variants` and the unused `React` default import is
// dropped so the file passes this project's strict tsconfig. No runtime difference.
// Styling only (Owen's UI standard, dark): the light-theme badge tints (bg-blue-100 etc.) are
// replaced with quiet bordered pills — the colored status icon is the signal; hover tints are
// white-on-black instead of black-on-white; completed rows are dimmed, not struck through (a
// struck-through "Cycle 1" reads as deleted); chip and card shadows dropped.

import { useState } from "react";
import { motion, AnimatePresence, LayoutGroup, type Variants } from "framer-motion";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
} from "lucide-react";

// Type definitions
export interface Subtask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  tools?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  level: number;
  dependencies: string[];
  subtasks: Subtask[];
}

// Initial task data
const initialTasks: Task[] = [
  {
    id: "1",
    title: "Research Project Requirements",
    description:
      "Gather all necessary information about the project scope and requirements",
    status: "in-progress",
    priority: "high",
    level: 0,
    dependencies: [],
    subtasks: [
      {
        id: "1.1",
        title: "Interview stakeholders",
        description:
          "Conduct interviews with key stakeholders to understand their needs and expectations",
        status: "completed",
        priority: "high",
        tools: ["communication-agent", "meeting-scheduler"],
      },
      {
        id: "1.2",
        title: "Review existing documentation",
        description:
          "Go through all available documentation and extract relevant information",
        status: "in-progress",
        priority: "medium",
        tools: ["file-system", "browser"],
      },
      {
        id: "1.3",
        title: "Compile findings report",
        description:
          "Create a comprehensive report summarizing all findings and recommendations",
        status: "need-help",
        priority: "medium",
        tools: ["docs-generator", "data-analyzer"],
      },
    ],
  },
  {
    id: "2",
    title: "Design System Architecture",
    description:
      "Create the overall system architecture based on requirements",
    status: "in-progress",
    priority: "high",
    level: 0,
    dependencies: [],
    subtasks: [
      {
        id: "2.1",
        title: "Define component structure",
        description:
          "Map out all major components and their relationships",
        status: "completed",
        priority: "high",
        tools: ["architecture-tool", "diagram-generator"],
      },
      {
        id: "2.2",
        title: "Design data flow",
        description:
          "Design how data will flow through the system",
        status: "in-progress",
        priority: "high",
        tools: ["data-modeling-tool"],
      },
    ],
  },
  {
    id: "3",
    title: "Implement Core Features",
    description: "Build the core functionality of the system",
    status: "pending",
    priority: "high",
    level: 1,
    dependencies: ["1", "2"],
    subtasks: [
      {
        id: "3.1",
        title: "Set up development environment",
        description:
          "Configure all necessary tools and environments for development",
        status: "pending",
        priority: "medium",
        tools: ["dev-env-setup", "package-manager"],
      },
    ],
  },
];

export interface PlanProps {
  tasks?: Task[];
}

export default function Plan({ tasks = initialTasks }: PlanProps) {
  const [expandedTasks, setExpandedTasks] = useState<string[]>(
    tasks.length > 0 ? [tasks[0].id] : []
  );
  const [expandedSubtasks, setExpandedSubtasks] = useState<{
    [key: string]: boolean;
  }>({});

  // Toggle task expansion
  const toggleTaskExpansion = (taskId: string) => {
    setExpandedTasks((prev) =>
      prev.includes(taskId)
        ? prev.filter((id) => id !== taskId)
        : [...prev, taskId],
    );
  };

  // Toggle subtask expansion
  const toggleSubtaskExpansion = (taskId: string, subtaskId: string) => {
    const key = `${taskId}-${subtaskId}`;
    setExpandedSubtasks((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // Animation variants
  const taskVariants: Variants = {
    hidden: { opacity: 0, y: -5 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] },
    },
    exit: { opacity: 0, y: -5, transition: { duration: 0.15 } },
  };

  const subtaskListVariants: Variants = {
    hidden: { opacity: 0, height: 0, overflow: "hidden" },
    visible: {
      height: "auto",
      opacity: 1,
      transition: {
        duration: 0.25,
        staggerChildren: 0.05,
        when: "beforeChildren",
        ease: [0.2, 0.65, 0.3, 0.9],
      },
    },
    exit: {
      opacity: 0,
      height: 0,
      transition: { duration: 0.2 },
    },
  };

  const subtaskVariants: Variants = {
    hidden: { opacity: 0, x: -10 },
    visible: {
      opacity: 1,
      x: 0,
      transition: { duration: 0.2, ease: [0.2, 0.65, 0.3, 0.9] },
    },
    exit: { opacity: 0, x: -10, transition: { duration: 0.15 } },
  };

  const subtaskDetailsVariants: Variants = {
    hidden: { opacity: 0, height: 0 },
    visible: {
      opacity: 1,
      height: "auto",
      transition: { duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] },
    },
    exit: { opacity: 0, height: 0, transition: { duration: 0.2 } },
  };

  const statusBadgeVariants: Variants = {
    initial: { opacity: 0, scale: 0.8 },
    animate: { opacity: 1, scale: 1, transition: { duration: 0.2 } },
    exit: { opacity: 0, scale: 0.8, transition: { duration: 0.15 } },
  };

  return (
    <div className="bg-background text-foreground h-full overflow-auto p-2">
      <motion.div
        className="bg-card border-border rounded-lg border overflow-hidden"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <LayoutGroup>
          <div className="p-4 overflow-hidden">
            <ul className="space-y-1 overflow-hidden">
              {tasks.map((task, index) => {
                const isExpanded = expandedTasks.includes(task.id);
                const isCompleted = task.status === "completed";

                return (
                  <motion.li
                    key={task.id}
                    className={` ${index !== 0 ? "mt-1 pt-2" : ""} `}
                    initial="hidden"
                    animate="visible"
                    variants={taskVariants}
                  >
                    {/* Task row */}
                    <motion.div
                      className="group flex items-center px-3 py-1.5 rounded-md"
                      whileHover={{
                        backgroundColor: "rgba(255,255,255,0.04)",
                        transition: { duration: 0.2 },
                      }}
                    >
                      <motion.div
                        className="mr-2 flex-shrink-0 cursor-default"
                        whileTap={{ scale: 0.9 }}
                      >
                        {task.status === "completed" ? (
                          <CheckCircle2 className="h-4.5 w-4.5 text-green-500" />
                        ) : task.status === "in-progress" ? (
                          <CircleDotDashed className="h-4.5 w-4.5 text-blue-500" />
                        ) : task.status === "need-help" ? (
                          <CircleAlert className="h-4.5 w-4.5 text-yellow-500" />
                        ) : task.status === "failed" ? (
                          <CircleX className="h-4.5 w-4.5 text-red-500" />
                        ) : (
                          <Circle className="text-muted-foreground h-4.5 w-4.5" />
                        )}
                      </motion.div>

                      <motion.div
                        className="flex min-w-0 flex-grow cursor-pointer items-center justify-between"
                        onClick={() => toggleTaskExpansion(task.id)}
                      >
                        <div className="mr-2 flex-1 truncate">
                          <span
                            className={`${isCompleted ? "text-muted-foreground" : ""}`}
                          >
                            {task.title}
                          </span>
                        </div>

                        <div className="flex flex-shrink-0 items-center space-x-2 text-xs">
                          {task.dependencies.length > 0 && (
                            <div className="flex items-center mr-2">
                              <div className="flex flex-wrap gap-1">
                                {task.dependencies.map((dep, idx) => (
                                  <motion.span
                                    key={idx}
                                    className="bg-secondary/40 rounded px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground tabular"
                                    initial={{ opacity: 0, y: -5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                      duration: 0.2,
                                      delay: idx * 0.05,
                                    }}
                                  >
                                    {dep}
                                  </motion.span>
                                ))}
                              </div>
                            </div>
                          )}

                          <motion.span
                            className={`rounded-full border px-2 py-0.5 text-[11px] ${
                              task.status === "completed"
                                ? "border-border text-muted-foreground"
                                : task.status === "in-progress"
                                  ? "border-input text-foreground"
                                  : task.status === "need-help"
                                    ? "border-border text-yellow-500"
                                    : task.status === "failed"
                                      ? "border-border text-red-400"
                                      : "border-border text-muted-foreground/60"
                            }`}
                            variants={statusBadgeVariants}
                            initial="initial"
                            animate="animate"
                            key={task.status}
                          >
                            {task.status}
                          </motion.span>
                        </div>
                      </motion.div>
                    </motion.div>

                    {/* Subtasks */}
                    <AnimatePresence mode="wait">
                      {isExpanded && task.subtasks.length > 0 && (
                        <motion.div
                          className="relative overflow-hidden"
                          variants={subtaskListVariants}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                          layout
                        >
                          {/* Vertical connecting line aligned with task icon */}
                          <div className="absolute top-0 bottom-0 left-[20px] border-l-2 border-dashed border-muted-foreground/30" />
                          <ul className="border-muted mt-1 mr-2 mb-1.5 ml-3 space-y-0.5">
                            {task.subtasks.map((subtask) => {
                              const subtaskKey = `${task.id}-${subtask.id}`;
                              const isSubtaskExpanded =
                                expandedSubtasks[subtaskKey];

                              return (
                                <motion.li
                                  key={subtask.id}
                                  className="group flex flex-col py-0.5 pl-6"
                                  onClick={() =>
                                    toggleSubtaskExpansion(task.id, subtask.id)
                                  }
                                  variants={subtaskVariants}
                                  initial="hidden"
                                  animate="visible"
                                  exit="exit"
                                  layout
                                >
                                  <motion.div
                                    className="flex flex-1 items-center rounded-md p-1"
                                    whileHover={{
                                      backgroundColor: "rgba(255,255,255,0.04)",
                                      transition: { duration: 0.2 },
                                    }}
                                    layout
                                  >
                                    <motion.div
                                      className="mr-2 flex-shrink-0 cursor-default"
                                      whileTap={{ scale: 0.9 }}
                                      layout
                                    >
                                      {subtask.status === "completed" ? (
                                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                      ) : subtask.status === "in-progress" ? (
                                        <CircleDotDashed className="h-3.5 w-3.5 text-blue-500" />
                                      ) : subtask.status === "need-help" ? (
                                        <CircleAlert className="h-3.5 w-3.5 text-yellow-500" />
                                      ) : subtask.status === "failed" ? (
                                        <CircleX className="h-3.5 w-3.5 text-red-500" />
                                      ) : (
                                        <Circle className="text-muted-foreground h-3.5 w-3.5" />
                                      )}
                                    </motion.div>

                                    <span
                                      className={`cursor-pointer text-sm ${subtask.status === "completed" ? "text-muted-foreground" : ""}`}
                                    >
                                      {subtask.title}
                                    </span>
                                  </motion.div>

                                  <AnimatePresence mode="wait">
                                    {isSubtaskExpanded && (
                                      <motion.div
                                        className="text-muted-foreground border-foreground/20 mt-1 ml-1.5 border-l border-dashed pl-5 text-xs overflow-hidden"
                                        variants={subtaskDetailsVariants}
                                        initial="hidden"
                                        animate="visible"
                                        exit="exit"
                                        layout
                                      >
                                        <p className="py-1">{subtask.description}</p>
                                        {subtask.tools && subtask.tools.length > 0 && (
                                          <div className="mt-0.5 mb-1 flex flex-wrap items-center gap-1.5">
                                            <span className="text-muted-foreground font-medium">
                                              tool calls:
                                            </span>
                                            <div className="flex flex-wrap gap-1">
                                              {subtask.tools.map((tool, idx) => (
                                                <motion.span
                                                  key={idx}
                                                  className="bg-secondary/40 text-secondary-foreground rounded px-1.5 py-0.5 text-[10px] font-medium tabular"
                                                  initial={{ opacity: 0, y: -5 }}
                                                  animate={{ opacity: 1, y: 0 }}
                                                  transition={{
                                                    duration: 0.2,
                                                    delay: idx * 0.05,
                                                  }}
                                                >
                                                  {tool}
                                                </motion.span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </motion.li>
                              );
                            })}
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </ul>
          </div>
        </LayoutGroup>
      </motion.div>
    </div>
  );
}
