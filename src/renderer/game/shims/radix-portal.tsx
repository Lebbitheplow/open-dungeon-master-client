// "@radix-ui/react-portal" for the game screens. Radix portals its
// dialogs, menus and tooltips to document.body, which sits outside the
// element the game's stylesheet is scoped to (scripts/scope-css.mjs), so
// they would render unstyled. This wrapper defaults the container to the
// game's root instead; an explicit container still wins.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore The real module, by path so the alias does not loop.
import { Portal as RealPortal } from "../../../../node_modules/@radix-ui/react-portal/dist/index.mjs";
import { forwardRef, type ComponentProps } from "preact/compat";
import type { JSX } from "preact";

type Props = ComponentProps<"div"> & { container?: Element | null };

function gameRoot(): Element | undefined {
  return document.querySelector(".game-root") ?? undefined;
}

export const Portal = forwardRef<HTMLDivElement, Props>(function Portal(props, ref) {
  const Real = RealPortal as unknown as (p: Props & { ref?: unknown }) => JSX.Element;
  return <Real {...props} container={props.container ?? gameRoot()} ref={ref} />;
});

export const Root = Portal;
