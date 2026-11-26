import { Fragment, type ReactNode } from "react";

type Props<T> = {
  items: T[];
  label: string;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  initialCount?: number;
};

export function CompactItems<T>({ items, label, getKey, renderItem, initialCount = 4 }: Props<T>) {
  const render = (values: T[]) => values.map(item => <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>);

  return (
    <div className="config-compact-items">
      {render(items.slice(0, initialCount))}
      {items.length > initialCount && (
        <details className="config-view-all">
          <summary>View all {items.length} {label}</summary>
          <div className="config-compact-rest">{render(items.slice(initialCount))}</div>
        </details>
      )}
    </div>
  );
}
