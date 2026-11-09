/* Raw admission component. Ordinary callback/log continuation adapters
 * are a separate unfinished stage; this file alone is not complete D59. */
WL_EXPORT void wl_event_queue_destroy(struct wl_event_queue *queue);
WL_EXPORT struct wl_event_queue * wl_display_create_queue(struct wl_display *display);
WL_EXPORT struct wl_event_queue * wl_display_create_queue_with_name(struct wl_display *display, const char *name);
WL_EXPORT struct wl_proxy * wl_proxy_create(struct wl_proxy *factory, const struct wl_interface *interface);
WL_EXPORT void wl_proxy_destroy(struct wl_proxy *proxy);
WL_EXPORT int wl_proxy_add_listener(struct wl_proxy *proxy,
		      void (**implementation)(void), void *data);
WL_EXPORT const void * wl_proxy_get_listener(struct wl_proxy *proxy);
WL_EXPORT int wl_proxy_add_dispatcher(struct wl_proxy *proxy,
			wl_dispatcher_func_t dispatcher,
			const void *implementation, void *data);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_constructor(struct wl_proxy *proxy,
				   uint32_t opcode, union wl_argument *args,
				   const struct wl_interface *interface);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_constructor_versioned(struct wl_proxy *proxy,
					     uint32_t opcode,
					     union wl_argument *args,
					     const struct wl_interface *interface,
					     uint32_t version);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_flags(struct wl_proxy *proxy, uint32_t opcode,
		       const struct wl_interface *interface, uint32_t version,
		       uint32_t flags, ...);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_flags(struct wl_proxy *proxy, uint32_t opcode,
			     const struct wl_interface *interface, uint32_t version,
			     uint32_t flags, union wl_argument *args);
WL_EXPORT void wl_proxy_marshal(struct wl_proxy *proxy, uint32_t opcode, ...);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_constructor(struct wl_proxy *proxy, uint32_t opcode,
			     const struct wl_interface *interface, ...);
WL_EXPORT struct wl_proxy * wl_proxy_marshal_constructor_versioned(struct wl_proxy *proxy, uint32_t opcode,
				       const struct wl_interface *interface,
				       uint32_t version, ...);
WL_EXPORT void wl_proxy_marshal_array(struct wl_proxy *proxy, uint32_t opcode,
		       union wl_argument *args);
WL_EXPORT int wl_display_get_fd(struct wl_display *display);
WL_EXPORT int wl_display_roundtrip_queue(struct wl_display *display, struct wl_event_queue *queue);
WL_EXPORT int wl_display_roundtrip(struct wl_display *display);
WL_EXPORT int wl_display_read_events(struct wl_display *display);
WL_EXPORT int wl_display_prepare_read_queue(struct wl_display *display,
			      struct wl_event_queue *queue);
WL_EXPORT int wl_display_prepare_read(struct wl_display *display);
WL_EXPORT void wl_display_cancel_read(struct wl_display *display);
WL_EXPORT int wl_display_dispatch_queue_timeout(struct wl_display *display,
				  struct wl_event_queue *queue,
				  const struct timespec *timeout);
WL_EXPORT int wl_display_dispatch_timeout(struct wl_display *display,
			    const struct timespec *timeout);
WL_EXPORT int wl_display_dispatch_queue(struct wl_display *display,
			  struct wl_event_queue *queue);
WL_EXPORT int wl_display_dispatch_queue_pending(struct wl_display *display,
				  struct wl_event_queue *queue);
WL_EXPORT int wl_display_dispatch(struct wl_display *display);
WL_EXPORT int wl_display_dispatch_pending(struct wl_display *display);
WL_EXPORT int wl_display_get_error(struct wl_display *display);
WL_EXPORT uint32_t wl_display_get_protocol_error(struct wl_display *display,
			      const struct wl_interface **interface,
			      uint32_t *id);
WL_EXPORT int wl_display_flush(struct wl_display *display);
WL_EXPORT void wl_display_set_max_buffer_size(struct wl_display *display,
                               size_t max_buffer_size);
WL_EXPORT void wl_proxy_set_user_data(struct wl_proxy *proxy, void *user_data);
WL_EXPORT void * wl_proxy_get_user_data(struct wl_proxy *proxy);
WL_EXPORT uint32_t wl_proxy_get_version(struct wl_proxy *proxy);
WL_EXPORT uint32_t wl_proxy_get_id(struct wl_proxy *proxy);
WL_EXPORT void wl_proxy_set_tag(struct wl_proxy *proxy,
		 const char * const *tag);
WL_EXPORT const char * const * wl_proxy_get_tag(struct wl_proxy *proxy);
WL_EXPORT const char * wl_proxy_get_class(struct wl_proxy *proxy);
WL_EXPORT const struct wl_interface * wl_proxy_get_interface(struct wl_proxy *proxy);
WL_EXPORT struct wl_display * wl_proxy_get_display(struct wl_proxy *proxy);
WL_EXPORT void wl_proxy_set_queue(struct wl_proxy *proxy, struct wl_event_queue *queue);
WL_EXPORT struct wl_event_queue * wl_proxy_get_queue(const struct wl_proxy *proxy);
WL_EXPORT const char * wl_event_queue_get_name(const struct wl_event_queue *queue);
WL_EXPORT void * wl_proxy_create_wrapper(void *proxy);
WL_EXPORT void wl_proxy_wrapper_destroy(void *proxy_wrapper);
static int wpk_wl_raw_arguments_admitted(struct wl_proxy *proxy,uint32_t opcode,union wl_argument *args){
    if(!_wpk_drm_native_fork_epoch())return 1;
    /* Primary provenance was proved before reading the native signature.
     * Only the restricted fresh-child path parses secondary object arguments;
     * variadic decoding itself remains the existing single upstream parse. */
    const char *signature=proxy->object.interface->methods[opcode].signature;
    int count=arg_count_for_signature(signature);
    for(int i=0;i<count;i++){
        struct argument_details argument;signature=get_next_argument(signature,&argument);
        if((argument.type==WL_ARG_OBJECT||argument.type==WL_ARG_NEW_ID)&&args[i].o&&
                !wpk_wl_native_pointer_admitted(args[i].o))return 0;
    }
    return 1;
}
WL_EXPORT void wl_event_queue_destroy(struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(queue)){return;}
    wpk_wl_private_queue_forget(queue);
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,queue->display);
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    _wpk_raw_native_wl_event_queue_destroy(queue);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return;}
}
WL_EXPORT struct wl_event_queue * wl_display_create_queue(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return NULL;}
    return _wpk_raw_native_wl_display_create_queue(display);
}
WL_EXPORT struct wl_event_queue * wl_display_create_queue_with_name(struct wl_display *display, const char *name) {
    if(!wpk_wl_native_pointer_admitted(display)){return NULL;}
    return _wpk_raw_native_wl_display_create_queue_with_name(display,name);
}
WL_EXPORT struct wl_proxy * wl_proxy_create(struct wl_proxy *factory, const struct wl_interface *interface) {
    if(!wpk_wl_native_pointer_admitted(factory)){return NULL;}
    return _wpk_raw_native_wl_proxy_create(factory,interface);
}
WL_EXPORT void wl_proxy_destroy(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}
    _wpk_raw_native_wl_proxy_destroy(proxy);
}
WL_EXPORT int wl_proxy_add_listener(struct wl_proxy *proxy,
		      void (**implementation)(void), void *data) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_proxy_add_listener(proxy,implementation,data);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT const void * wl_proxy_get_listener(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_listener(proxy);
}
WL_EXPORT int wl_proxy_add_dispatcher(struct wl_proxy *proxy,
			wl_dispatcher_func_t dispatcher,
			const void *implementation, void *data) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_proxy_add_dispatcher(proxy,dispatcher,implementation,data);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_constructor(struct wl_proxy *proxy,
				   uint32_t opcode, union wl_argument *args,
				   const struct wl_interface *interface) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    if(!wpk_wl_raw_arguments_admitted(proxy,opcode,args)){return NULL;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    struct wl_proxy * result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_proxy_marshal_array_constructor(proxy,opcode,args,interface);
    completed=wpk_wl_raw_entry_end(&entry,result,WPK_RAW_PROXY);
    pthread_cleanup_pop(0);if(!completed){return NULL;}
    return result;
}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_constructor_versioned(struct wl_proxy *proxy,
					     uint32_t opcode,
					     union wl_argument *args,
					     const struct wl_interface *interface,
					     uint32_t version) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    if(!wpk_wl_raw_arguments_admitted(proxy,opcode,args)){return NULL;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    struct wl_proxy * result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_proxy_marshal_array_constructor_versioned(proxy,opcode,args,interface,version);
    completed=wpk_wl_raw_entry_end(&entry,result,WPK_RAW_PROXY);
    pthread_cleanup_pop(0);if(!completed){return NULL;}
    return result;
}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_flags(struct wl_proxy *proxy, uint32_t opcode,
		       const struct wl_interface *interface, uint32_t version,
		       uint32_t flags, ...) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}

	union wl_argument args[WL_CLOSURE_MAX_ARGS];
	va_list ap;

	va_start(ap, flags);
	wl_argument_from_va_list(proxy->object.interface->methods[opcode].signature,
				 args, WL_CLOSURE_MAX_ARGS, ap);
	va_end(ap);

	return wl_proxy_marshal_array_flags(proxy, opcode, interface, version, flags, args);

}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_array_flags(struct wl_proxy *proxy, uint32_t opcode,
			     const struct wl_interface *interface, uint32_t version,
			     uint32_t flags, union wl_argument *args) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    if(!wpk_wl_raw_arguments_admitted(proxy,opcode,args)){return NULL;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    struct wl_proxy * result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_proxy_marshal_array_flags(proxy,opcode,interface,version,flags,args);
    completed=wpk_wl_raw_entry_end(&entry,result,WPK_RAW_PROXY);
    pthread_cleanup_pop(0);if(!completed){return NULL;}
    return result;
}
WL_EXPORT void wl_proxy_marshal(struct wl_proxy *proxy, uint32_t opcode, ...) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}

	union wl_argument args[WL_CLOSURE_MAX_ARGS];
	va_list ap;

	va_start(ap, opcode);
	wl_argument_from_va_list(proxy->object.interface->methods[opcode].signature,
				 args, WL_CLOSURE_MAX_ARGS, ap);
	va_end(ap);

	wl_proxy_marshal_array_constructor(proxy, opcode, args, NULL);

}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_constructor(struct wl_proxy *proxy, uint32_t opcode,
			     const struct wl_interface *interface, ...) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}

	union wl_argument args[WL_CLOSURE_MAX_ARGS];
	va_list ap;

	va_start(ap, interface);
	wl_argument_from_va_list(proxy->object.interface->methods[opcode].signature,
				 args, WL_CLOSURE_MAX_ARGS, ap);
	va_end(ap);

	return wl_proxy_marshal_array_constructor(proxy, opcode,
						  args, interface);

}
WL_EXPORT struct wl_proxy * wl_proxy_marshal_constructor_versioned(struct wl_proxy *proxy, uint32_t opcode,
				       const struct wl_interface *interface,
				       uint32_t version, ...) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}

	union wl_argument args[WL_CLOSURE_MAX_ARGS];
	va_list ap;

	va_start(ap, version);
	wl_argument_from_va_list(proxy->object.interface->methods[opcode].signature,
				 args, WL_CLOSURE_MAX_ARGS, ap);
	va_end(ap);

	return wl_proxy_marshal_array_constructor_versioned(proxy, opcode,
							    args, interface,
							    version);

}
WL_EXPORT void wl_proxy_marshal_array(struct wl_proxy *proxy, uint32_t opcode,
		       union wl_argument *args) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}
    if(!wpk_wl_raw_arguments_admitted(proxy,opcode,args)){return;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,proxy->display);
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    _wpk_raw_native_wl_proxy_marshal_array(proxy,opcode,args);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return;}
}
WL_EXPORT int wl_display_get_fd(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    return _wpk_raw_native_wl_display_get_fd(display);
}
WL_EXPORT int wl_display_roundtrip_queue(struct wl_display *display, struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_roundtrip_queue(display,queue);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_roundtrip(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_roundtrip(display);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_read_events(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_read_events(display);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_prepare_read_queue(struct wl_display *display,
			      struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return -1;}
    return _wpk_raw_native_wl_display_prepare_read_queue(display,queue);
}
WL_EXPORT int wl_display_prepare_read(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    return _wpk_raw_native_wl_display_prepare_read(display);
}
WL_EXPORT void wl_display_cancel_read(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return;}
    _wpk_raw_native_wl_display_cancel_read(display);
}
WL_EXPORT int wl_display_dispatch_queue_timeout(struct wl_display *display,
				  struct wl_event_queue *queue,
				  const struct timespec *timeout) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch_queue_timeout(display,queue,timeout);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_dispatch_timeout(struct wl_display *display,
			    const struct timespec *timeout) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch_timeout(display,timeout);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_dispatch_queue(struct wl_display *display,
			  struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch_queue(display,queue);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_dispatch_queue_pending(struct wl_display *display,
				  struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch_queue_pending(display,queue);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_dispatch(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch(display);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_dispatch_pending(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int result;
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    result=_wpk_raw_native_wl_display_dispatch_pending(display);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return -1;}
    return result;
}
WL_EXPORT int wl_display_get_error(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return ECHILD;}
    return _wpk_raw_native_wl_display_get_error(display);
}
WL_EXPORT uint32_t wl_display_get_protocol_error(struct wl_display *display,
			      const struct wl_interface **interface,
			      uint32_t *id) {
    if(!wpk_wl_native_pointer_admitted(display)){return 0;}
    return _wpk_raw_native_wl_display_get_protocol_error(display,interface,id);
}
WL_EXPORT int wl_display_flush(struct wl_display *display) {
    if(!wpk_wl_native_pointer_admitted(display)){return -1;}
    return _wpk_raw_native_wl_display_flush(display);
}
WL_EXPORT void wl_display_set_max_buffer_size(struct wl_display *display,
                               size_t max_buffer_size) {
    if(!wpk_wl_native_pointer_admitted(display)){return;}
    struct wpk_wl_raw_entry entry;wpk_wl_raw_entry_begin(&entry,display);
    int completed;pthread_cleanup_push(wpk_wl_raw_entry_abandon,&entry);
    _wpk_raw_native_wl_display_set_max_buffer_size(display,max_buffer_size);
    completed=wpk_wl_raw_entry_end(&entry,NULL,WPK_RAW_NONE);
    pthread_cleanup_pop(0);if(!completed){return;}
}
WL_EXPORT void wl_proxy_set_user_data(struct wl_proxy *proxy, void *user_data) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}
    _wpk_raw_native_wl_proxy_set_user_data(proxy,user_data);
}
WL_EXPORT void * wl_proxy_get_user_data(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_user_data(proxy);
}
WL_EXPORT uint32_t wl_proxy_get_version(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return 0;}
    return _wpk_raw_native_wl_proxy_get_version(proxy);
}
WL_EXPORT uint32_t wl_proxy_get_id(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return 0;}
    return _wpk_raw_native_wl_proxy_get_id(proxy);
}
WL_EXPORT void wl_proxy_set_tag(struct wl_proxy *proxy,
		 const char * const *tag) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}
    _wpk_raw_native_wl_proxy_set_tag(proxy,tag);
}
WL_EXPORT const char * const * wl_proxy_get_tag(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_tag(proxy);
}
WL_EXPORT const char * wl_proxy_get_class(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_class(proxy);
}
WL_EXPORT const struct wl_interface * wl_proxy_get_interface(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_interface(proxy);
}
WL_EXPORT struct wl_display * wl_proxy_get_display(struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_display(proxy);
}
WL_EXPORT void wl_proxy_set_queue(struct wl_proxy *proxy, struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return;}
    if(queue&&!wpk_wl_native_pointer_admitted(queue)){return;}
    _wpk_raw_native_wl_proxy_set_queue(proxy,queue);
}
WL_EXPORT struct wl_event_queue * wl_proxy_get_queue(const struct wl_proxy *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_get_queue(proxy);
}
WL_EXPORT const char * wl_event_queue_get_name(const struct wl_event_queue *queue) {
    if(!wpk_wl_native_pointer_admitted(queue)){return NULL;}
    return _wpk_raw_native_wl_event_queue_get_name(queue);
}
WL_EXPORT void * wl_proxy_create_wrapper(void *proxy) {
    if(!wpk_wl_native_pointer_admitted(proxy)){return NULL;}
    return _wpk_raw_native_wl_proxy_create_wrapper(proxy);
}
WL_EXPORT void wl_proxy_wrapper_destroy(void *proxy_wrapper) {
    if(!wpk_wl_native_pointer_admitted(proxy_wrapper)){return;}
    _wpk_raw_native_wl_proxy_wrapper_destroy(proxy_wrapper);
}
