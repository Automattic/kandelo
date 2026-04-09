/*  This file is part of GNU bc.

    Copyright (C) 1991-1994, 1997, 2006, 2008, 2012-2017 Free Software Foundation, Inc.

    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License , or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program; see the file COPYING.  If not, see
    <http://www.gnu.org/licenses>.

    You may contact the author by:
       e-mail:  philnelson@acm.org
      us-mail:  Philip A. Nelson
                Computer Science Department, 9062
                Western Washington University
                Bellingham, WA 98226-9062
       
*************************************************************************/

/* proto.h: Prototype function definitions for "external" functions. */

/* For the pc version using k&r ACK. (minix1.5 and earlier.) */
#ifdef SHORTNAMES
#define init_numbers i_numbers
#define push_constant push__constant
#define load_const in_load_const
#define yy_get_next_buffer yyget_next_buffer
#define yy_init_buffer yyinit_buffer
#define yy_last_accepting_state yylast_accepting_state
#define arglist1 arg1list
#endif

/* Include the standard library header files. */
#ifdef HAVE_UNISTD_H
#include <unistd.h>
#endif
#ifdef HAVE_STDLIB_H
#include <stdlib.h>
#endif

/* From execute.c */
void stop_execution (int);
unsigned char byte (program_counter *pc_);
void execute (void);
int prog_char (void);
int input_char (void);
void push_constant (int (*in_char)(void), int conv_base);
void push_b10_const (program_counter *pc_);
void assign (char code);

/* From util.c */
char *strcopyof (const char *str);
arg_list *nextarg (arg_list *args, int val, int is_var);
char *arg_str (arg_list *args);
char *call_str (arg_list *args);
void free_args (arg_list *args);
void check_params (arg_list *params, arg_list *autos);
void set_genstr_size (int);
void init_gen (void);
void generate (const char *str);
void run_code (void);
void out_char (int ch);
void out_schar (int ch);
id_rec *find_id (id_rec *tree, const char *id);
int insert_id_rec (id_rec **root, id_rec *new_id);
void init_tree (void);
int lookup (char *name, int namekind);
void *bc_malloc (size_t);
void out_of_memory (void);
void welcome (void);
void warranty (const char *);
void show_bc_version (void);
void limits (void);
void yyerror (const char *str ,...);
void ct_warn (const char *mesg ,...);
void rt_error (const char *mesg ,...);
void rt_warn (const char *mesg ,...);
void bc_exit (int);

/* From load.c */
void init_load (void);
void addbyte (unsigned char thebyte);
void def_label (unsigned long lab);
long long_val (const char **str);
void load_code (const char *code);

/* From main.c */
int open_new_file (void);
void new_yy_file (FILE *file);
void use_quit (int);

/* From storage.c */
void init_storage (void);
void more_functions (void);
void more_variables (void);
void more_arrays (void);
void clear_func (int func);
int fpop (void);
void fpush (int val);
void pop (void);
void push_copy (bc_num num);
void push_num (bc_num num);
char check_stack (int depth);
bc_var *get_var (int var_name);
bc_num *get_array_num (int var_index, unsigned long _index_);
void store_var (int var_name);
void store_array (int var_name);
void load_var (int var_name);
void load_array (int var_name);
void decr_var (int var_name);
void decr_array (int var_name);
void incr_var (int var_name);
void incr_array (int var_name);
void auto_var (int name);
void free_a_tree (bc_array_node *root, int depth);
void pop_vars (arg_list *list);
void process_params (program_counter *_pc_, int func);

/* For the scanner and parser.... */
int yyparse (void);
int yylex (void);

#if defined(LIBEDIT)
/* The *?*&^ prompt function */
char *null_prompt (EditLine *);
#endif

/* Other things... */
#ifndef HAVE_UNISTD_H
(int getopt (int, char *[], CONST char *);
#endif
