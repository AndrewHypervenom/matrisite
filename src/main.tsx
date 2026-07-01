import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider } from 'convex/react'
import { convex } from './lib/convex'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
)
