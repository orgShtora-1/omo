/// <reference types="bun" />

declare namespace Bun {
  interface Test<Context = unknown> {
    timeout: number
  }

  interface TestOptions<Context = unknown> {
    timeout?: number
  }
}
