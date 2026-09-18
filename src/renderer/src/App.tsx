import type { JSX } from 'react'
import { RealtimePage } from './components/realtime/RealtimePage'

export default function App(): JSX.Element {
  return (
    <div className="h-full w-full flex flex-col bg-bg text-text">
      <RealtimePage />
    </div>
  )
}
