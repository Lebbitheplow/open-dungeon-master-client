// The route table (index.tsx) imports the server's page components through
// the bundler's "@/" alias (scripts/build-renderer.mjs); tsc only needs to
// know they are page modules. A script file, not a module, so this is an
// ambient declaration rather than an augmentation.
declare module "@/app/*" {
  const page: import("preact").ComponentType<{ params: unknown; searchParams?: unknown }>;
  export default page;
}
