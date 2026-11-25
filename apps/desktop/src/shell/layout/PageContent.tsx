import type { ReactNode } from "react";
import { PageTitle } from "../PageActions";
import { ScrollableContent } from "../../shared/virtual/ScrollableContent";
import type { VirtualPageSection } from "./VirtualPage";
import { VirtualPage } from "./VirtualPage";
import styles from "./PageContent.module.scss";

export function PageContent({ title, sections, contentClassName, fixed = false }: { title?: ReactNode; sections: VirtualPageSection[]; contentClassName?: string; fixed?: boolean }) {
  return <div className={styles.root}>
    {title != null && <PageTitle>{title}</PageTitle>}
    {fixed
      ? <ScrollableContent
          scrollbarInsetTop="var(--app-content-top)"
          className={[styles.fixedScroll, "scroll-shadow-top"].join(" ")}
          contentClassName={[styles.fixedContent, contentClassName].filter(Boolean).join(" ")}
        >
          {sections.map((section) => <section className={styles.fixedSection} key={section.key}>{section.content}</section>)}
        </ScrollableContent>
      : <VirtualPage sections={sections} contentClassName={contentClassName} />}
  </div>;
}
