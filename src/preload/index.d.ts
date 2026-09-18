import type { TbApi } from '@shared/ipc'

declare global {
  interface Window {
    tb: TbApi
  }
}

export {}
