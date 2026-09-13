import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last line of defense for the demo: a render error anywhere below (a record shape the derive code
 * did not expect, a WebGL context that failed to create) must not blank the whole page. React
 * unmounts the entire tree on an uncaught render error; this keeps it to a quiet inline note and,
 * at the root, a way back to the intro without a hard refresh.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label ?? "ui"}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <main className="min-h-full px-6 pt-16 md:px-10 md:pt-20">
        <div className="mx-auto w-full max-w-[1040px]">
          <h1 className="text-[40px] font-medium leading-none tracking-[-0.025em]">Something broke</h1>
          <p className="mt-3 text-[13px] text-[var(--muted)]">
            {this.props.label ?? "this screen"} hit an error it could not recover from.{" "}
            <button
              type="button"
              className="rounded underline underline-offset-2 hover:text-[var(--fg)]"
              onClick={() => {
                window.location.search = "?page=intro";
              }}
            >
              Back to start
            </button>
          </p>
          <pre className="mt-6 max-w-full overflow-x-auto text-[12px] text-[var(--faint)]">
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
        </div>
      </main>
    );
  }
}
