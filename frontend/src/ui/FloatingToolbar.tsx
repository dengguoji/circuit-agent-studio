import { CheckCircle2, CircleAlert, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

export type FloatingToolbarAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hiddenOnCompact?: boolean;
};

export type FloatingToolbarGroup = {
  id: string;
  actions: FloatingToolbarAction[];
};

export type CanvasStatusProps = {
  valid: boolean;
  issueCount?: number;
  label?: string;
  details?: string;
  onClick?: () => void;
  className?: string;
};

export type FloatingToolbarProps = {
  title?: string;
  metadata?: string;
  groups: FloatingToolbarGroup[];
  status?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  overflowMenu?: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function CanvasStatus({
  valid,
  issueCount = 0,
  label,
  details,
  onClick,
  className = "",
}: CanvasStatusProps) {
  const content = (
    <>
      {valid ? <CheckCircle2 aria-hidden="true" size={15} /> : <CircleAlert aria-hidden="true" size={15} />}
      <span>{label ?? (valid ? "Canvas valid" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`)}</span>
      {details && <small>{details}</small>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={["cw-canvas-status", valid ? "is-valid" : "is-invalid", className].filter(Boolean).join(" ")} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={["cw-canvas-status", valid ? "is-valid" : "is-invalid", className].filter(Boolean).join(" ")}>{content}</div>;
}

export function FloatingToolbar({
  title,
  metadata,
  groups,
  status,
  leading,
  trailing,
  overflowMenu,
  className = "",
  ariaLabel = "Canvas toolbar",
}: FloatingToolbarProps) {
  return (
    <header className={["cw-floating-toolbar", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      {(leading || title) && (
        <div className="cw-toolbar-identity">
          {leading}
          {title && <strong>{title}</strong>}
          {metadata && <code>{metadata}</code>}
        </div>
      )}
      <div className="cw-toolbar-groups">
        {groups.map((group) => (
          <div key={group.id} className="cw-toolbar-group" role="group">
            {group.actions.map((action) => (
              <button
                type="button"
                key={action.id}
                className={[
                  action.active ? "is-active" : "",
                  action.danger ? "is-danger" : "",
                  action.hiddenOnCompact ? "is-compact-hidden" : "",
                ].filter(Boolean).join(" ")}
                onClick={action.onClick}
                disabled={action.disabled}
                aria-label={action.label}
                aria-pressed={action.active === undefined ? undefined : action.active}
                title={action.label}
              >
                {action.icon}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="cw-toolbar-trailing">
        {status}
        {trailing}
        {overflowMenu && (
          <details className="cw-toolbar-overflow">
            <summary aria-label="More canvas actions" title="More canvas actions">
              <MoreHorizontal aria-hidden="true" size={17} />
            </summary>
            <div className="cw-toolbar-overflow-menu">{overflowMenu}</div>
          </details>
        )}
      </div>
    </header>
  );
}
