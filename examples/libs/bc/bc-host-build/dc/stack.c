/* 
 * implement stack functions for dc
 *
 * Copyright (C) 1994, 1997, 1998, 2000, 2005, 2006, 2008, 2012, 2016
 * Free Software Foundation, Inc.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

/* This module is the only one that knows what stacks (both the
 * regular evaluation stack and the named register stacks)
 * look like.
 */

#include "config.h"

#include <stdio.h>
#ifdef HAVE_STDLIB_H
# include <stdlib.h>
#endif
#include "dc.h"
#include "dc-proto.h"
#include "dc-regdef.h"

/* an oft-used error message: */
#define Empty_Stack	fprintf(stderr, "%s: stack empty\n", progname)


/* simple linked-list implementation suffices: */
struct dc_list {
	dc_data value;
	struct dc_array *array;	/* opaque */
	struct dc_list *link;
};
typedef struct dc_list dc_list;

/* the anonymous evaluation stack */
static dc_list *dc_stack=NULL;

/* the named register stacks */
typedef dc_list *dc_listp;
static dc_listp dc_register[DC_REGCOUNT];


/* allocate a new dc_list item */
static dc_list *
dc_alloc DC_DECLVOID()
{
	dc_list *result;

	result = dc_malloc(sizeof *result);
	result->value.dc_type = DC_UNINITIALIZED;
	result->array = NULL;
	result->link = NULL;
	return result;
}


/* check that there are two numbers on top of the stack,
 * then call op with the popped numbers.  Construct a dc_data
 * value from the dc_num returned by op and push it
 * on the stack.
 * If the op call doesn't return DC_SUCCESS, then leave the stack
 * unmodified.
 */
void
dc_binop DC_DECLARG((op, kscale))
	int (*op)DC_PROTO((dc_num, dc_num, int, dc_num *)) DC_DECLSEP
	int kscale DC_DECLEND
{
	dc_data a;
	dc_data b;
	dc_data r;

	if (dc_stack == NULL  ||  dc_stack->link == NULL){
		Empty_Stack;
		return;
	}
	if (dc_stack->value.dc_type!=DC_NUMBER
			|| dc_stack->link->value.dc_type!=DC_NUMBER){
		fprintf(stderr, "%s: non-numeric value\n", progname);
		return;
	}
	(void)dc_pop(&b);
	(void)dc_pop(&a);
	if ((*op)(a.v.number, b.v.number, kscale, &r.v.number) == DC_SUCCESS){
		r.dc_type = DC_NUMBER;
		dc_push(r);
		dc_free_num(&a.v.number);
		dc_free_num(&b.v.number);
	}else{
		/* op failed; restore the stack */
		dc_push(a);
		dc_push(b);
	}
}

/* check that there are two numbers on top of the stack,
 * then call op with the popped numbers.  Construct two dc_data
 * values from the dc_num's returned by op and push them
 * on the stack.
 * If the op call doesn't return DC_SUCCESS, then leave the stack
 * unmodified.
 */
void
dc_binop2 DC_DECLARG((op, kscale))
	int (*op)DC_PROTO((dc_num, dc_num, int, dc_num *, dc_num *)) DC_DECLSEP
	int kscale DC_DECLEND
{
	dc_data a;
	dc_data b;
	dc_data r1;
	dc_data r2;

	if (dc_stack == NULL  ||  dc_stack->link == NULL){
		Empty_Stack;
		return;
	}
	if (dc_stack->value.dc_type!=DC_NUMBER
			|| dc_stack->link->value.dc_type!=DC_NUMBER){
		fprintf(stderr, "%s: non-numeric value\n", progname);
		return;
	}
	(void)dc_pop(&b);
	(void)dc_pop(&a);
	if ((*op)(a.v.number, b.v.number, kscale,
								&r1.v.number, &r2.v.number) == DC_SUCCESS){
		r1.dc_type = DC_NUMBER;
		dc_push(r1);
		r2.dc_type = DC_NUMBER;
		dc_push(r2);
		dc_free_num(&a.v.number);
		dc_free_num(&b.v.number);
	}else{
		/* op failed; restore the stack */
		dc_push(a);
		dc_push(b);
	}
}

/* check that there are two numbers on top of the stack,
 * then call dc_compare with the popped numbers.
 * Return negative, zero, or positive based on the ordering
 * of the two numbers.
 */
int
dc_cmpop DC_DECLVOID()
{
	int result;
	dc_data a;
	dc_data b;

	if (dc_stack == NULL  ||  dc_stack->link == NULL){
		Empty_Stack;
		return 0;
	}
	if (dc_stack->value.dc_type!=DC_NUMBER
			|| dc_stack->link->value.dc_type!=DC_NUMBER){
		fprintf(stderr, "%s: non-numeric value\n", progname);
		return 0;
	}
	(void)dc_pop(&b);
	(void)dc_pop(&a);
	result = dc_compare(b.v.number, a.v.number);
	dc_free_num(&a.v.number);
	dc_free_num(&b.v.number);
	return result;
}

/* check that there are three numbers on top of the stack,
 * then call op with the popped numbers.  Construct a dc_data
 * value from the dc_num returned by op and push it
 * on the stack.
 * If the op call doesn't return DC_SUCCESS, then leave the stack
 * unmodified.
 */
void
dc_triop DC_DECLARG((op, kscale))
	int (*op)DC_PROTO((dc_num, dc_num, dc_num, int, dc_num *)) DC_DECLSEP
	int kscale DC_DECLEND
{
	dc_data a;
	dc_data b;
	dc_data c;
	dc_data r;

	if (dc_stack == NULL
			|| dc_stack->link == NULL
			|| dc_stack->link->link == NULL){
		Empty_Stack;
		return;
	}
	if (dc_stack->value.dc_type!=DC_NUMBER
			|| dc_stack->link->value.dc_type!=DC_NUMBER
			|| dc_stack->link->link->value.dc_type!=DC_NUMBER){
		fprintf(stderr, "%s: non-numeric value\n", progname);
		return;
	}
	(void)dc_pop(&c);
	(void)dc_pop(&b);
	(void)dc_pop(&a);
	if ((*op)(a.v.number, b.v.number, c.v.number,
				kscale, &r.v.number) == DC_SUCCESS){
		r.dc_type = DC_NUMBER;
		dc_push(r);
		dc_free_num(&a.v.number);
		dc_free_num(&b.v.number);
		dc_free_num(&c.v.number);
	}else{
		/* op failed; restore the stack */
		dc_push(a);
		dc_push(b);
		dc_push(c);
	}
}


/* initialize the register stacks to their initial values */
void
dc_register_init DC_DECLVOID()
{
	int i;

	for (i=0; i<DC_REGCOUNT; ++i)
		dc_register[i] = NULL;
}

/* clear the evaluation stack */
void
dc_clear_stack DC_DECLVOID()
{
	dc_list *n;
	dc_list *t;

	for (n=dc_stack; n!=NULL; n=t){
		t = n->link;
		if (n->value.dc_type == DC_NUMBER)
			dc_free_num(&n->value.v.number);
		else if (n->value.dc_type == DC_STRING)
			dc_free_str(&n->value.v.string);
		else
			dc_garbage("in stack", -1);
		dc_array_free(n->array);
		free(n);
	}
	dc_stack = NULL;
}

/* push a value onto the evaluation stack */
void
dc_push DC_DECLARG((value))
	dc_data value DC_DECLEND
{
	dc_list *n = dc_alloc();

	if (value.dc_type!=DC_NUMBER && value.dc_type!=DC_STRING)
		dc_garbage("in data being pushed", -1);
	n->value = value;
	n->link = dc_stack;
	dc_stack = n;
}

/* push a value onto the named register stack */
void
dc_register_push DC_DECLARG((stackid, value))
	int stackid DC_DECLSEP
	dc_data value DC_DECLEND
{
	dc_list *n = dc_alloc();

	stackid = regmap(stackid);
	n->value = value;
	n->link = dc_register[stackid];
	dc_register[stackid] = n;
}

/* set *result to the value on the top of the evaluation stack */
/* The caller is responsible for duplicating the value if it
 * is to be maintained as anything more than a transient identity.
 *
 * DC_FAIL is returned if the stack is empty (and *result unchanged),
 * DC_SUCCESS is returned otherwise
 */
int
dc_top_of_stack DC_DECLARG((result))
	dc_data *result DC_DECLEND
{
	if (dc_stack == NULL){
		Empty_Stack;
		return DC_FAIL;
	}
	if (dc_stack->value.dc_type!=DC_NUMBER
			&& dc_stack->value.dc_type!=DC_STRING)
		dc_garbage("at top of stack", -1);
	*result = dc_stack->value;
	return DC_SUCCESS;
}

/* set *result to a dup of the value on the top of the named register stack,
 * or 0 (zero) if the stack is empty */
/*
 * DC_FAIL is returned if an internal bug is detected
 * DC_SUCCESS is returned otherwise
 */
int
dc_register_get DC_DECLARG((regid, result))
	int regid DC_DECLSEP
	dc_data *result DC_DECLEND
{
	dc_list *r;

	regid = regmap(regid);
	r = dc_register[regid];
	if (r==NULL){
		*result = dc_int2data(0);
	}else if (r->value.dc_type==DC_UNINITIALIZED){
		fprintf(stderr, "%s: BUG: register ", progname);
		dc_show_id(stderr, regid, " exists but is uninitialized?\n");
		return DC_FAIL;
	}else{
		*result = dc_dup(r->value);
	}
	return DC_SUCCESS;
}

/* set the top of the named register stack to the indicated value */
/* If the named stack is empty, craft a stack entry to enter the
 * value into.
 */
void
dc_register_set DC_DECLARG((regid, value))
	int regid DC_DECLSEP
	dc_data value DC_DECLEND
{
	dc_list *r;

	regid = regmap(regid);
	r = dc_register[regid];
	if (r == NULL)
		dc_register[regid] = dc_alloc();
	else if (r->value.dc_type == DC_NUMBER)
		dc_free_num(&r->value.v.number);
	else if (r->value.dc_type == DC_STRING)
		dc_free_str(&r->value.v.string);
	else if (r->value.dc_type == DC_UNINITIALIZED)
		;
	else
		dc_garbage("", regid);
	dc_register[regid]->value = value;
}

/* pop from the evaluation stack
 *
 * DC_FAIL is returned if the stack is empty (and *result unchanged),
 * DC_SUCCESS is returned otherwise
 */
int
dc_pop DC_DECLARG((result))
	dc_data *result DC_DECLEND
{
	dc_list *r;

	r = dc_stack;
	if (r==NULL || r->value.dc_type==DC_UNINITIALIZED){
		Empty_Stack;
		return DC_FAIL;
	}
	if (r->value.dc_type!=DC_NUMBER && r->value.dc_type!=DC_STRING)
		dc_garbage("at top of stack", -1);
	*result = r->value;
	dc_stack = r->link;
	dc_array_free(r->array);
	free(r);
	return DC_SUCCESS;
}

/* pop from the named register stack
 *
 * DC_FAIL is returned if the named stack is empty (and *result unchanged),
 * DC_SUCCESS is returned otherwise
 */
int
dc_register_pop DC_DECLARG((stackid, result))
	int stackid DC_DECLSEP
	dc_data *result DC_DECLEND
{
	dc_list *r;

	stackid = regmap(stackid);
	r = dc_register[stackid];
	if (r==NULL || r->value.dc_type==DC_UNINITIALIZED){
		fprintf(stderr, "%s: stack register ", progname);
		dc_show_id(stderr, stackid, " is empty\n");
		return DC_FAIL;
	}
	if (r->value.dc_type!=DC_NUMBER && r->value.dc_type!=DC_STRING)
		dc_garbage(" stack", stackid);
	*result = r->value;
	dc_register[stackid] = r->link;
	dc_array_free(r->array);
	free(r);
	return DC_SUCCESS;
}


/* cyclically rotate the "n" topmost elements of the stack;
 *   negative "n" rotates forward (topomost element becomes n-th deep)
 *   positive "n" rotates backward (topmost element becomes 2nd deep)
 *
 * If stack depth is less than "n", whole stack is rotated
 * (without raising an error).
 */
void
dc_stack_rotate(int n)
{
	dc_list *p; /* becomes bottom of sub-stack */
	dc_list *r; /* predecessor of "p" */
	int absn = n<0 ? -n : n;

	/* always do nothing for empty stack or degenerate rotation depth */
	if (!dc_stack || absn < 2)
		return;
	/* find bottom of rotation sub-stack */
	r = NULL;
	for (p=dc_stack; p->link && --absn>0; p=p->link)
		r = p;
	/* if stack has only one element, treat rotation as no-op */
	if (!r)
		return;
	/* do the rotation, in appropriate direction */
	if (n > 0) {
		r->link = p->link;
		p->link = dc_stack;
		dc_stack = p;
	} else {
		dc_list *new_tos = dc_stack->link;
		dc_stack->link = p->link;
		p->link = dc_stack;
		dc_stack = new_tos;
	}
}


/* tell how many entries are currently on the evaluation stack */
int
dc_tell_stackdepth DC_DECLVOID()
{
	dc_list *n;
	int depth=0;

	for (n=dc_stack; n!=NULL; n=n->link)
		++depth;
	return depth;
}


/* return the length of the indicated data value;
 * if discard_p is DC_TOSS, the deallocate the value when done
 *
 * The definition of a datum's length is deligated to the
 * appropriate module.
 */
int
dc_tell_length DC_DECLARG((value, discard_p))
	dc_data value DC_DECLSEP
	dc_discard discard_p DC_DECLEND
{
	int length;

	if (value.dc_type == DC_NUMBER){
		length = dc_numlen(value.v.number);
		if (discard_p == DC_TOSS)
			dc_free_num(&value.v.number);
	} else if (value.dc_type == DC_STRING) {
		length = (int) dc_strlen(value.v.string);
		if (discard_p == DC_TOSS)
			dc_free_str(&value.v.string);
	} else {
		dc_garbage("in tell_length", -1);
		/*NOTREACHED*/
		length = 0;	/*just to suppress spurious compiler warnings*/
	}
	return length;
}



/* print out all of the values on the evaluation stack */
void
dc_printall DC_DECLARG((obase))
	int obase DC_DECLEND
{
	dc_list *n;

	for (n=dc_stack; n!=NULL; n=n->link)
		dc_print(n->value, obase, DC_WITHNL, DC_KEEP);
}




/* get the current array head for the named array */
struct dc_array *
dc_get_stacked_array DC_DECLARG((array_id))
	int array_id DC_DECLEND
{
	dc_list *r = dc_register[regmap(array_id)];
	return r == NULL ? NULL : r->array;
}

/* set the current array head for the named array */
void
dc_set_stacked_array DC_DECLARG((array_id, new_head))
	int array_id DC_DECLSEP
	struct dc_array *new_head DC_DECLEND
{
	dc_list *r;

	array_id = regmap(array_id);
	r = dc_register[array_id];
	if (r == NULL)
		r = dc_register[array_id] = dc_alloc();
	r->array = new_head;
}


/*
 * Local Variables:
 * mode: C
 * tab-width: 4
 * End:
 * vi: set ts=4 :
 */
