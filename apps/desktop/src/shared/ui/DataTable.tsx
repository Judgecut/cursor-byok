import { useEffect, useMemo, useState, type ReactNode, type RefCallback } from "react";
import { ScrollableContent } from "../virtual/ScrollableContent";
import { Pagination } from "./Pagination";
import styles from "./DataTable.module.scss";

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  title?: (row: T) => string | undefined;
  className?: string;
  sticky?: "right";
};

export type ServerPagination = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowClassName,
  rowRef,
  minWidth,
  emptyText = t("暂无数据"),
  loading = false,
  loadingText = t("加载中…"),
  serverPagination,
}: {
  rows: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string | number;
  rowClassName?: (row: T) => string;
  rowRef?: (row: T) => RefCallback<HTMLTableRowElement>;
  minWidth?: number | string;
  emptyText?: ReactNode;
  loading?: boolean;
  loadingText?: ReactNode;
  serverPagination?: ServerPagination;
}) {
  const [clientPage, setClientPage] = useState(1);
  const [clientPageSize, setClientPageSize] = useState(20);

  const total = serverPagination ? serverPagination.total : rows.length;
  const pageSize = serverPagination ? serverPagination.pageSize : clientPageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = serverPagination ? Math.min(serverPagination.page, pageCount) : clientPage;

  useEffect(() => {
    if (!serverPagination && clientPage > pageCount) setClientPage(pageCount);
  }, [clientPage, pageCount, serverPagination]);

  const pageRows = useMemo(
    () => (serverPagination ? rows : rows.slice((page - 1) * pageSize, page * pageSize)),
    [page, pageSize, rows, serverPagination],
  );

  const showEmpty = pageRows.length === 0;
  const overlayText = loading && showEmpty ? loadingText : showEmpty ? emptyText : null;

  return <div className={styles.root}>
    <div className={styles.tableRegion}>
      <ScrollableContent
        horizontal
        className={[styles.viewport, showEmpty ? styles.emptyViewport : ""].filter(Boolean).join(" ")}
        viewportClassName={styles.tableViewport}
        contentClassName={styles.tableContent}
        scrollbarInsetTop="33px"
      >
        <table className={styles.table} style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((column) => <th key={column.key} className={columnClass(column)}>{column.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => <tr key={rowKey(row)} className={rowClassName?.(row)} ref={rowRef?.(row)}>
              {columns.map((column) => (
                <td key={column.key} className={columnClass(column)} title={column.title?.(row)}>
                  {column.render(row)}
                </td>
              ))}
            </tr>)}
          </tbody>
        </table>
      </ScrollableContent>
      {overlayText !== null && <div className={styles.emptyState}>{overlayText}</div>}
    </div>
    <Pagination
      page={page}
      pageCount={pageCount}
      pageSize={pageSize}
      total={total}
      onPageChange={(nextPage) => {
        if (serverPagination) serverPagination.onPageChange(nextPage);
        else setClientPage(nextPage);
      }}
      onPageSizeChange={(nextPageSize) => {
        if (serverPagination) serverPagination.onPageSizeChange(nextPageSize);
        else {
          setClientPageSize(nextPageSize);
          setClientPage(1);
        }
      }}
    />
  </div>;
}

function columnClass<T>(column: DataTableColumn<T>) {
  return [column.className, column.sticky === "right" ? styles.stickyRight : ""].filter(Boolean).join(" ") || undefined;
}
