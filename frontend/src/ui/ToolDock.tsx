import { ChevronRight, Library, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

export type ToolDockSection = {
  id: string;
  label: string;
  content: ReactNode;
  count?: number;
  disabled?: boolean;
};

export type ToolDockProps = {
  sections: ToolDockSection[];
  activeSectionId: string;
  onSectionChange: (sectionId: string) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  title?: string;
  subtitle?: string;
  headerActions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  ariaLabel?: string;
};

export function ToolDock({
  sections,
  activeSectionId,
  onSectionChange,
  collapsed = false,
  onCollapsedChange,
  title = "Circuit tools",
  subtitle,
  headerActions,
  footer,
  className = "",
  ariaLabel = "Circuit tools and inspector",
}: ToolDockProps) {
  const activeSection = sections.find((section) => section.id === activeSectionId) ?? sections[0];

  if (collapsed) {
    return (
      <aside className={["cw-floating-dock", "cw-tool-dock", "is-collapsed", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
        <button
          type="button"
          className="cw-collapsed-trigger"
          onClick={() => onCollapsedChange?.(false)}
          aria-label="Open circuit tools"
          aria-expanded="false"
        >
          <Library aria-hidden="true" size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className={["cw-floating-dock", "cw-tool-dock", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      <header className="cw-dock-header">
        <div className="cw-dock-title">
          <span className="cw-dock-mark"><SlidersHorizontal aria-hidden="true" size={16} /></span>
          <span>
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </span>
        </div>
        <div className="cw-dock-header-actions">
          {headerActions}
          {onCollapsedChange && (
            <button type="button" onClick={() => onCollapsedChange(true)} aria-label="Collapse circuit tools" aria-expanded="true">
              <ChevronRight aria-hidden="true" size={17} />
            </button>
          )}
        </div>
      </header>

      {sections.length > 1 && (
        <nav className="cw-tool-tabs" aria-label="Tool panel sections">
          {sections.map((section) => (
            <button
              type="button"
              key={section.id}
              className={section.id === activeSection?.id ? "is-active" : ""}
              onClick={() => onSectionChange(section.id)}
              disabled={section.disabled}
              aria-current={section.id === activeSection?.id ? "page" : undefined}
            >
              <span>{section.label}</span>
              {section.count !== undefined && <code>{section.count}</code>}
            </button>
          ))}
        </nav>
      )}

      <div className="cw-tool-dock-body">{activeSection?.content}</div>
      {footer && <footer className="cw-tool-dock-footer">{footer}</footer>}

    </aside>
  );
}
