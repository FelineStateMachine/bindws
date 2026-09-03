/// <reference types="@cloudflare/vitest-pool-workers/types" />
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
// The generated Env predates the custom domain map; tests seed it directly.
declare namespace Cloudflare {
  interface Env {
    HOSTS: KVNamespace;
  }
}
