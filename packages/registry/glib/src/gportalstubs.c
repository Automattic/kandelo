/* Link stubs for the xdg-desktop-portal client entry points.
 *
 * gappinfo.c, gdesktopappinfo.c and glocalfile.c reference these four
 * functions behind `glib_should_use_portal ()`, which is always FALSE
 * on wasm32-posix-kernel (no sandbox marker file, no portal service).
 * The upstream implementations live in gopenuriportal.c /
 * gdocumentportal.c / gtrashportal.c and require GDBus, which PR21
 * excludes (a session dbus daemon lands in PR22). Replacing the
 * unreachable implementations keeps libgio-2.0.a free of the gdbus
 * object graph.
 */

#include "config.h"

#include <gio/gio.h>

gboolean
g_openuri_portal_open_file (GFile       *file,
                            const char  *parent_window,
                            const char  *startup_id,
                            GError     **error)
{
  g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                       "OpenURI portal is not supported on this platform");
  return FALSE;
}

void
g_openuri_portal_open_file_async (GFile               *file,
                                  const char          *parent_window,
                                  const char          *startup_id,
                                  GCancellable        *cancellable,
                                  GAsyncReadyCallback  callback,
                                  gpointer             user_data)
{
  g_task_report_new_error (file, callback, user_data,
                           g_openuri_portal_open_file_async,
                           G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                           "OpenURI portal is not supported on this platform");
}

gboolean
g_openuri_portal_open_file_finish (GAsyncResult  *result,
                                   GError       **error)
{
  return g_task_propagate_boolean (G_TASK (result), error);
}

GList *
g_document_portal_add_documents (GList       *uris,
                                 const char  *app_id,
                                 GError     **error)
{
  g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                       "Document portal is not supported on this platform");
  return NULL;
}

gboolean
g_trash_portal_trash_file (GFile   *file,
                           GError **error)
{
  g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED,
                       "Trash portal is not supported on this platform");
  return FALSE;
}
