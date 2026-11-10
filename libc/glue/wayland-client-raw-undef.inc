#undef wl_event_queue_destroy
#undef wl_display_create_queue
#undef wl_display_create_queue_with_name
#undef wl_proxy_create
#undef wl_proxy_destroy
#undef wl_proxy_add_listener
#undef wl_proxy_get_listener
#undef wl_proxy_add_dispatcher
#undef wl_proxy_marshal_array_constructor
#undef wl_proxy_marshal_array_constructor_versioned
#undef wl_proxy_marshal_flags
#undef wl_proxy_marshal_array_flags
#undef wl_proxy_marshal
#undef wl_proxy_marshal_constructor
#undef wl_proxy_marshal_constructor_versioned
#undef wl_proxy_marshal_array
#undef wl_display_get_fd
#undef wl_display_roundtrip_queue
#undef wl_display_roundtrip
#undef wl_display_read_events
#undef wl_display_prepare_read_queue
#undef wl_display_prepare_read
#undef wl_display_cancel_read
#undef wl_display_dispatch_queue_timeout
#undef wl_display_dispatch_timeout
#undef wl_display_dispatch_queue
#undef wl_display_dispatch_queue_pending
#undef wl_display_dispatch
#undef wl_display_dispatch_pending
#undef wl_display_get_error
#undef wl_display_get_protocol_error
#undef wl_display_flush
#undef wl_display_set_max_buffer_size
#undef wl_proxy_set_user_data
#undef wl_proxy_get_user_data
#undef wl_proxy_get_version
#undef wl_proxy_get_id
#undef wl_proxy_set_tag
#undef wl_proxy_get_tag
#undef wl_proxy_get_class
#undef wl_proxy_get_interface
#undef wl_proxy_get_display
#undef wl_proxy_set_queue
#undef wl_proxy_get_queue
#undef wl_event_queue_get_name
#undef wl_proxy_create_wrapper
#undef wl_proxy_wrapper_destroy
#undef malloc
#undef calloc
#undef zalloc
#undef free
#undef wl_closure_invoke
#undef wl_closure_dispatch
#undef wl_closure_destroy
#undef wl_list_remove
#undef arg_count_for_signature
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
