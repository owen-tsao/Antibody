import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { redirectLegacy } from './lib/routes.ts'

// Pre-shell `?page=` links are rewritten to their path before anything renders, so the first
// paint is already at the right address and Back does not return to the query-string form.
redirectLegacy()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Antibody">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
