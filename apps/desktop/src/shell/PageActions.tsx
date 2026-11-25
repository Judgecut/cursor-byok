import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeepAliveContext } from "keepalive-for-react";

type PageActionsTargets = {
  title: HTMLElement | null;
  left: HTMLElement | null;
  right: HTMLElement | null;
};

export const PageActionsTarget = createContext<PageActionsTargets>({ title: null, left: null, right: null });

export function PageTitle({ children }: { children: ReactNode })
{
  const { title } = useContext(PageActionsTarget);
  const { active } = useKeepAliveContext();
  return active && title ? createPortal(<h1>{children}</h1>, title) : null;
}

export function PageActions({ children, position = "right" }: { children: ReactNode; position?: "left" | "right" }) {
  const targets = useContext(PageActionsTarget);
  const { active } = useKeepAliveContext();
  const target = targets[position];
  return active && target ? createPortal(children, target) : null;
}
