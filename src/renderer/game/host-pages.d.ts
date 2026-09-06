// The route table (index.tsx) imports the server's page components through
// the bundler's "@/" alias (scripts/build-renderer.mjs); tsc only needs to
// know they are page modules. A script file, not a module, so this is an
// ambient declaration rather than an augmentation.
declare module "@/app/*" {
  const page: import("preact").ComponentType<{ params: unknown; searchParams?: unknown }>;
  export default page;
}

// The server's device panel (src/components/DeviceSettings.tsx), mounted on
// the shell's Settings screen.
declare module "@/components/DeviceSettings" {
  import type { ComponentType } from "preact/compat";
  export const DeviceSettings: ComponentType<Record<string, never>>;
}
