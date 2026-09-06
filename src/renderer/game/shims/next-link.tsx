// "next/link" for the game screens: a plain anchor whose click goes
// through the GameRouter, so host pages open natively and full URLs leave
// for the web view or the browser. Modifier clicks and target=_blank keep
// the browser's behaviour.
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from "preact/compat";
import { useRouter } from "./next-navigation.js";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | { pathname?: string; query?: Record<string, string> };
  replace?: boolean;
  prefetch?: boolean;
  scroll?: boolean;
};

function hrefOf(href: Props["href"]): string {
  if (typeof href === "string") return href;
  const query = href.query ? `?${new URLSearchParams(href.query).toString()}` : "";
  return `${href.pathname ?? "/"}${query}`;
}

const Link = forwardRef<HTMLAnchorElement, Props>(function Link(
  { href, replace, onClick, children, ...rest },
  ref,
) {
  const router = useRouter();
  const url = hrefOf(href);
  // Next-only hints, not anchor attributes.
  delete (rest as { prefetch?: boolean }).prefetch;
  delete (rest as { scroll?: boolean }).scroll;
  return (
    <a
      ref={ref}
      href={url}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (rest.target && rest.target !== "_self") return;
        event.preventDefault();
        if (replace) router.replace(url);
        else router.push(url);
      }}
      {...rest}
    >
      {children}
    </a>
  );
});

export default Link;
