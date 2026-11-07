/* Included after the native adapter's connection/surface records and mutex.
 * D-59 checks ONLY platform-owned metadata. The inherited display/proxy graph
 * can contain a pointer freed by a vanished thread; even reading through that
 * graph to decide whether it is safe would defeat this boundary. */
static int wpk_wl_boundary_required_locked(const struct wpk_wl_connection *record) {
    return record&&record->native_fork_epoch!=_wpk_drm_native_fork_epoch();
}
static int wpk_wl_boundary_mark_locked(struct wpk_wl_connection *record) {
    if(record->boundary_reported)return 0;
    record->boundary_reported=1;return 1;
}
static void wpk_wl_boundary_diagnose(int report) {
    if(report){
        static const char message[]="Kandelo Wayland: inherited native connection after multithreaded fork is unavailable until exec/exit; preserving parent resources (D-59)\n";
        /* A copied stdio or logging mutex may belong to a vanished thread.
         * Raw stderr write avoids calling application handlers or traversing
         * native state. Descriptor inheritance otherwise keeps normal policy. */
        (void)write(STDERR_FILENO,message,sizeof message-1);
    }
    errno=ECHILD;
}
int _wpk_wl_display_boundary_required(void *lease) {
    struct wpk_wl_connection *record=lease;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    int required=wpk_wl_boundary_required_locked(record);
    int report=required&&wpk_wl_boundary_mark_locked(record);
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(required)wpk_wl_boundary_diagnose(report);
    return required;
}
int _wpk_wl_surface_boundary_required(void *lease) {
    struct wpk_wl_surface *hold=lease;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    /* Once proxy release sealed NULL, its remaining nested display capsule
     * classifies its own connection. Do not reinterpret a completed C shell
     * as an inherited native leaf merely because it was born before fork. */
    struct wpk_wl_connection *record=hold&&hold->proxy?hold->connection:NULL;
    int required=wpk_wl_boundary_required_locked(record);
    int report=required&&wpk_wl_boundary_mark_locked(record);
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(required)wpk_wl_boundary_diagnose(report);
    return required;
}
/* Callers hold wpk_wl_mutex. Transfer the ACTUAL heap graph before changing a
 * caller edge; neither users nor native references are decremented. `alive`
 * stops new private admission, while the independent root outlives shells. */
static int wpk_wl_transfer_connection_boundary_locked(struct wpk_wl_connection *record,int *report) {
    if(!wpk_wl_boundary_required_locked(record))return 0;
    *report=wpk_wl_boundary_mark_locked(record);
    _wpk_drm_owned_publication_begin();
    _wpk_wl_boundary_transfer_locked(&record->boundary);record->alive=0;
    _wpk_drm_owned_publication_end();return 1;
}
int _wpk_wl_display_transfer_boundary(void *lease) {
    struct wpk_wl_connection *record=lease;int report=0;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    int transferred=wpk_wl_transfer_connection_boundary_locked(record,&report);
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(transferred)wpk_wl_boundary_diagnose(report);
    return transferred;
}
int _wpk_wl_surface_transfer_boundary(void *lease) {
    struct wpk_wl_surface *hold=lease;int report=0,transferred=0;
    _wpk_drm_mutex_lock(&wpk_wl_mutex);
    if(hold&&hold->proxy&&wpk_wl_boundary_required_locked(hold->connection)){
        struct wpk_wl_connection *record=hold->connection;
        report=wpk_wl_boundary_mark_locked(record);
        _wpk_drm_owned_publication_begin();
        _wpk_wl_boundary_transfer_locked(&record->boundary);
        _wpk_wl_boundary_transfer_locked(&hold->boundary);record->alive=0;
        _wpk_drm_owned_publication_end();transferred=1;
    }
    _wpk_drm_mutex_unlock(&wpk_wl_mutex);
    if(transferred)wpk_wl_boundary_diagnose(report);
    return transferred;
}
