# GTK signal contract repair scope

Pinned GTK3.24.34 archive SHA256 `dbc69f90ddc821b8d1441f00374dc1da4323a2eafa9078e61edbe5eeefa852ec`, after the normal recipe patches. This is a bounded dispatch audit, not an assertion that every GTK callback is compatible.

The review inventories literal production GTK/GDK hookups for realize, unrealize, map, unmap, show, hide, destroy, style-updated, notify, size-allocate, draw, screen-changed, state-flags-changed, direction-changed, and hierarchy-changed. Exact emitter types distinguish GdkKeymap::direction-changed from GtkWidget::direction-changed. Comments, casts, conditional expressions and external definitions require separate source review; a regex inventory alone is not a clean bill.

The six library hierarchy-changed registrations are gtkdragdest, Quartz DND, GtkUIManager, Inspector statistics, GtkPopover, and GtkTextHandle. The portable drag-destination callback and Inspector statistics omitted closure data. The other four have three arguments already. Paired portable drag-destination realize omitted data as well; Quartz already has it.

Class vfuncs keep their declared instance/signal-argument signature, without closure data. Connected callbacks include data; swapped callbacks receive data first and the emitter last. GTK/public GObject contracts remain unchanged. Direct helper calls keep their original signatures. Function-identity disconnect/find operations use the same new adapters as the registrations; GtkIconHelper splits its old shared identity into separate typed notify and direction-changed identities. Model-change callbacks retain the original saved-handler-ID cleanup.

The same-helper alias review includes three GtkTreeModel row signals (inserted4, deleted3, reordered5 including data/emitter) and all eight compiled gtk_widget_destroy signal registrations: four lifecycle and four GtkDialog::response. The ninth callback use is GtkCallback in Inspector container traversal. Direct destroy calls and compatible one-pointer GDestroyNotify storage remain unchanged.

GTK drag-icon draw signals return gboolean and use G_CONNECT_AFTER. Typed adapters preserve painting and return FALSE, allowing later handlers, as specified by GtkWidget::draw (gtk/gtkwidget.c). Cairo pattern cleanup uses the actual two-argument GClosureNotify contract and still destroys the same pattern exactly once.

## Reviewed adapter inventory

Each row records the original helper and the full ordered connected-adapter parameters. `swapped` and `G_CONNECT_SWAPPED` preserve the original registration flags. Line numbers refer to the normal pinned source before this patch. Cleanup identities are checked with registrations, not inferred from signature compatibility.

| Source / helper | Exact adapter parameters | Hook / flags | Function-identity cleanup lines |
|---|---|---|---|
| `gtk/a11y/gtkcolorswatchaccessible.c` / `state_changed_cb` | `void (GtkWidget *widget, GtkStateFlags previous_flags, gpointer data)` | state-flags-changed @57 g_signal_connect | handler ID / none |
| `gtk/a11y/gtkiconviewaccessible.c` / `gtk_icon_view_accessible_notify_gtk` | `void (GObject *obj, GParamSpec *pspec, gpointer data)` | notify @1314 g_signal_connect | handler ID / none |
| `gtk/a11y/gtkpanedaccessible.c` / `gtk_paned_accessible_size_allocate_gtk` | `void (GtkWidget *widget, GtkAllocation *allocation, gpointer data)` | size-allocate @44 g_signal_connect | handler ID / none |
| `gtk/deprecated/gtkcolorsel.c` / `gtk_widget_destroy` | `void (GtkWidget *widget, gpointer data)` | hide @1456 g_signal_connect | handler ID / none |
| `gtk/deprecated/gtkimagemenuitem.c` / `gtk_image_menu_item_setting_changed` | `void (GtkSettings *settings, GParamSpec *pspec, gpointer data)` | notify::gtk-menu-images @1265 g_signal_connect | 1259 |
| `gtk/deprecated/gtkuimanager.c` / `update_smart_separators` | `void (GtkWidget *proxy, GParamSpec *pspec, gpointer data)` | notify::visible @2734 g_signal_connect; notify::visible @2935 g_signal_connect; notify::visible @2987 g_signal_connect | 2890, 2926, 2952, 2979 |
| `gtk/gtkaboutdialog.c` / `gtk_widget_destroy` | `void (GtkDialog *dialog, gint response_id, gpointer data)` | response @1009 g_signal_connect | handler ID / none |
| `gtk/gtkappchooserdialog.c` / `gtk_widget_destroy` | `void (GtkDialog *dialog, gint response_id, gpointer data)` | response @433 g_signal_connect | handler ID / none |
| `gtk/gtkbutton.c` / `gtk_button_setting_changed` | `void (GtkSettings *settings, GParamSpec *pspec, gpointer data)` | notify::gtk-button-images @2513 g_signal_connect | 2507 |
| `gtk/gtkcolorbutton.c` / `dialog_destroy` | `void (GtkWidget *widget, gpointer data)` | destroy @572 g_signal_connect | handler ID / none |
| `gtk/gtkcolorchooserwidget.c` / `save_custom_colors` | `void (GtkColorChooserWidget *cc, GParamSpec *pspec, GtkWidget *swatch)` | notify::rgba @222 g_signal_connect_swapped | handler ID / none |
| `gtk/gtkdnd.c` / `gtk_drag_draw_icon_pattern` | `gboolean (GtkWidget *window, cairo_t *cr, gpointer pattern)` | draw @2361 g_signal_connect_data | handler ID / none |
| `gtk/gtkdnd.c` / `gtk_drag_draw_icon_pattern_and_background` | `gboolean (GtkWidget *window, cairo_t *cr, gpointer pattern)` | draw @2361 g_signal_connect_data | handler ID / none |
| `gtk/gtkemojicompletion.c` / `entry_focus_out` | `void (GtkWidget *entry, GParamSpec *pspec, GtkEmojiCompletion *completion)` | notify::has-focus @417 g_signal_connect | 425 |
| `gtk/gtkentrycompletion.c` / `clear_completion_callback` | `void (GtkEntry *entry, GParamSpec *pspec, gpointer data)` | notify @2625 g_signal_connect | 2686 |
| `gtk/gtkfontchooserdialog.c` / `update_button` | `void (GtkFontChooserDialog *dialog, GParamSpec *pspec, GtkWidget *fontchooser)` | notify::font-desc @267 g_signal_connect_swapped | handler ID / none |
| `gtk/gtkfontchooserdialog.c` / `update_tweak_button` | `void (GtkFontChooserDialog *dialog, GParamSpec *pspec, GtkWidget *fontchooser)` | notify::level @271 g_signal_connect_swapped | handler ID / none |
| `gtk/gtkfontchooserwidget.c` / `fontconfig_changed` | `void (GtkFontChooserWidget *fontchooser, GParamSpec *pspec, GtkSettings *settings)` | notify::gtk-fontconfig-timestamp @1307 g_signal_connect_object G_CONNECT_SWAPPED | 1304 |
| `gtk/gtkfontchooserwidget.c` / `update_font_features` | `void (GtkFontChooserWidget *fontchooser, GParamSpec *pspec, GtkWidget *feat)` | notify::active @2231 g_signal_connect_swapped; notify::inconsistent @2232 g_signal_connect_swapped; notify::active @2311 g_signal_connect_swapped | handler ID / none |
| `gtk/gtkheaderbar.c` / `_gtk_header_bar_update_window_buttons` | `void (GtkHeaderBar *bar, GParamSpec *pspec, GtkSettings *settings)` | notify::gtk-shell-shows-app-menu @1930 g_signal_connect_swapped; notify::gtk-decoration-layout @1932 g_signal_connect_swapped | 1944 |
| `gtk/gtkiconhelper.c` / `gtk_icon_helper_invalidate` | `void (GtkIconHelper *self, GParamSpec *pspec, GtkWidget *widget)` | notify::scale-factor @178 g_signal_connect_swapped | 190 |
| `gtk/gtkiconhelper.c` / `gtk_icon_helper_invalidate` | `void (GtkIconHelper *self, GtkTextDirection previous_direction, GtkWidget *widget)` | direction-changed @177 g_signal_connect_swapped | 190 |
| `gtk/gtkimmulticontext.c` / `im_module_setting_changed` | `void (GtkSettings *settings, GParamSpec *pspec, gpointer data)` | notify::gtk-im-module @322 g_signal_connect | handler ID / none |
| `gtk/gtklabel.c` / `label_shortcut_setting_changed` | `void (GtkSettings *settings, GParamSpec *pspec, gpointer data)` | notify::gtk-enable-mnemonics @2023 g_signal_connect; notify::gtk-enable-accels @2026 g_signal_connect | handler ID / none |
| `gtk/gtkmenubutton.c` / `popover_destroy_cb` | `void (GtkMenuButton *menu_button, GtkWidget *popover)` | destroy @1175 g_signal_connect_swapped | 1056, 1161 |
| `gtk/gtkplacessidebar.c` / `set_prelight` | `void (GtkPopover *popover, gpointer data)` | map @2812 g_signal_connect | handler ID / none |
| `gtk/gtkplacessidebar.c` / `unset_prelight` | `void (GtkPopover *popover, gpointer data)` | unmap @2813 g_signal_connect | handler ID / none |
| `gtk/gtkpopover.c` / `back_to_main` | `void (GtkWidget *popover, gpointer data)` | unmap @2566 g_signal_connect; map @2567 g_signal_connect | handler ID / none |
| `gtk/gtkprintoperation.c` / `gtk_widget_destroy` | `void (GtkDialog *dialog, gint response_id, gpointer data)` | response @3047 g_signal_connect | handler ID / none |
| `gtk/gtkrecentmanager.c` / `gtk_recent_manager_enabled_changed` | `void (GtkRecentManager *manager, GParamSpec *pspec, GtkSettings *settings)` | notify::gtk-recent-files-enabled @347 g_signal_connect_swapped | handler ID / none |
| `gtk/gtkshortcutswindow.c` / `gtk_shortcuts_window__search_mode__changed` | `void (GtkShortcutsWindow *self, GParamSpec *pspec, GtkSearchBar *search_bar)` | notify::search-mode-enabled @996 g_signal_connect_object G_CONNECT_SWAPPED | handler ID / none |
| `gtk/gtkshortcutswindow.c` / `update_title_stack` | `void (GtkShortcutsWindow *self, GParamSpec *pspec, GtkStack *stack)` | notify::visible-child @1066 g_signal_connect_object G_CONNECT_SWAPPED | 657 |
| `gtk/gtkstacksidebar.c` / `disconnect_stack_signals` | `void (GtkStackSidebar *sidebar, GtkWidget *stack)` | destroy @412 g_signal_connect_swapped | 398 |
| `gtk/gtkstackswitcher.c` / `disconnect_stack_signals` | `void (GtkStackSwitcher *switcher, GtkWidget *stack)` | destroy @497 g_signal_connect_swapped | 482 |
| `gtk/gtktestutils.c` / `try_main_quit` | `void (GtkWidget *widget, gpointer data)` | destroy @674 g_signal_connect; destroy @721 g_signal_connect | handler ID / none |
| `gtk/gtktreeselection.c` / `model_changed` | `void (gpointer data, GParamSpec *pspec, GtkTreeView *tree_view)` | notify::model @793 g_signal_connect_swapped | handler ID / none |
| `gtk/gtktreeselection.c` / `model_changed` | `void (gpointer data, GtkTreePath *path, GtkTreeIter *iter, GtkTreeModel *model)` | row-inserted @784 g_signal_connect_swapped | handler ID / none |
| `gtk/gtktreeselection.c` / `model_changed` | `void (gpointer data, GtkTreePath *path, GtkTreeModel *model)` | row-deleted @787 g_signal_connect_swapped | handler ID / none |
| `gtk/gtktreeselection.c` / `model_changed` | `void (gpointer data, GtkTreePath *path, GtkTreeIter *iter, gint *new_order, GtkTreeModel *model)` | rows-reordered @790 g_signal_connect_swapped | handler ID / none |
| `gtk/gtktreeviewcolumn.c` / `gtk_tree_view_column_setup_sort_column_id_callback` | `void (GtkTreeViewColumn *tree_column, GParamSpec *pspec, GtkTreeView *tree_view)` | notify::model @1403 g_signal_connect_swapped | handler ID / none |
| `gtk/inspector/actions.c` / `gtk_widget_destroy` | `void (GtkWidget *widget, gpointer data)` | hide @268 g_signal_connect | handler ID / none |
| `gtk/inspector/css-editor.c` / `gtk_widget_destroy` | `void (GtkDialog *dialog, gint response_id, gpointer data)` | response @165 g_signal_connect | handler ID / none |
| `gtk/inspector/css-node-tree.c` / `gtk_widget_destroy` | `void (GtkWidget *widget, gpointer data)` | unmap @107 g_signal_connect | handler ID / none |
| `gtk/inspector/gtkstackcombo.c` / `on_child_visible_changed` | `void (GtkStackCombo *self, GParamSpec *pspec, GtkWidget *widget)` | notify::visible @77 g_signal_connect_swapped | 76, 120 |
| `gtk/inspector/gtkstackcombo.c` / `disconnect_stack_signals` | `void (GtkStackCombo *self, GtkWidget *stack)` | destroy @139 g_signal_connect_swapped | 131 |
| `gtk/inspector/inspect-button.c` / `clear_flash` | `void (GtkInspectorWindow *iw, GtkWidget *widget)` | unmap @208 g_signal_connect_swapped | 194, 437, 475 |
| `gtk/inspector/misc-info.c` / `gtk_widget_destroy` | `void (GtkWidget *widget, gpointer data)` | GtkCallback @344 gtk_container_forall | handler ID / none |
| `gtk/inspector/prop-list.c` / `gtk_widget_destroy` | `void (GtkWidget *widget, gpointer data)` | unmap @241 g_signal_connect | handler ID / none |
| `gtk/inspector/prop-list.c` / `cleanup_object` | `void (GtkInspectorPropList *pl, GtkWidget *widget)` | destroy @566 g_signal_connect_object G_CONNECT_SWAPPED | handler ID / none |
| `gtk/inspector/resource-list.c` / `on_map` | `void (GtkWidget *widget, gpointer data)` | map @597 g_signal_connect | handler ID / none |
| `gtk/inspector/strv-editor.c` / `emit_changed` | `void (GtkInspectorStrvEditor *editor, GParamSpec *pspec, GtkEntry *entry)` | notify::text @73 g_signal_connect_swapped | handler ID / none |
| `gtk/inspector/visual.c` / `update_touchscreen` | `void (GtkSwitch *sw, GParamSpec *pspec, gpointer data)` | notify::active @746 g_signal_connect | handler ID / none |

Additional core adapters are gtkdragdest.c: gtk_drag_dest_realized_cb(GtkWidget*,gpointer), gtk_drag_dest_hierarchy_changed_cb(GtkWidget*,GtkWidget*,gpointer); Inspector statistics hierarchy_changed now includes gpointer data. gtk_drag_icon_pattern_destroy(gpointer,GClosure*) handles Cairo cleanup.

## Evidence and remaining obligations

The focused real GObject matrix has62 cases: the original50 plus twelve VOID__OBJECT/VOID__VOID class, normal, swapped, emitv/emit-va and disconnect checks, with non-NULL distinct object/argument/data pointers. A private diagnostic linked the exact normal9a GLib6/libffi3 closure and own SDK32:62/62 passed. This is not a fresh normal fixture publication or GTK/browser acceptance. The ten original upstream GObject targets retain all assertions; the six previously failing targets remain ordinary required gaps.

All52 added family-adapter definitions compile in41 extracted type-control TUs against actual installed GTK headers and actual private header declarations. Complete original helper prototypes are retained for compile checking. This validates adapter calls/signatures, not complete GTK TU configuration or library rebuilds. The separate actual-source GTK control uses complete drag-destination helpers/adapters with real normal GTK7 libraries and expected invalid-widget precondition diagnostics; its runtime result must be reported separately.

Before normal package execution, the final unified patch is applied with --fuzz=0 and no offsets, and every complete resulting TU is compared byte-for-byte to the reviewed after source. GTK revision8 and normal reverse consumers still require a fresh normal build and real valid-widget/browser compositor lifecycle acceptance. ABI56 is unchanged.

Outside the normal Wayland configuration: Win32 default-display notify; X11 status-icon notify/screen/size hooks; X11 GtkSocket notify; optional CloudProviders notify. These are source-confirmed omissions left outside this build, not repaired/validated features or hard platform boundaries. GdkKeymap direction callbacks, gtk_widget_destroyed callbacks, and three explicit notify C-casts already match their actual signal machine signatures.

Unexamined dynamic signal names, nonliteral callback construction, other signal families and non-signal callback tables remain unproven. This repair makes no exhaustive GTK/GIO/GObject compatibility claim.
