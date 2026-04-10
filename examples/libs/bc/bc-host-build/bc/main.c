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

/* main.c: The main program for bc.  */

#include "bcdefs.h"
#include <signal.h>
#include <errno.h>
#include "proto.h"
#include "getopt.h"


/* Variables for processing multiple files. */
static char first_file;

/* Points to the last node in the file name list for easy adding. */
static file_node *last = NULL;

#if defined(LIBEDIT)
/* The prompt for libedit. */
char el_pmtchars[] = "";
static char *el_pmtfunc(void);
static char *el_pmtfunc(void) { return el_pmtchars; }
#endif

/* long option support */
static struct option long_options[] =
{
  {"compile",     0, &compile_only, TRUE},
  {"help",        0, 0,             'h'},
  {"interactive", 0, 0,             'i'},
  {"mathlib",     0, &use_math,     TRUE},
  {"quiet",       0, &quiet,        TRUE},
  {"standard",    0, &std_only,     TRUE},
  {"version",     0, 0,             'v'},
  {"warn",        0, &warn_not_std, TRUE},

  {0, 0, 0, 0}
};


static void
usage (const char *progname)
{
  printf ("usage: %s [options] [file ...]\n%s%s%s%s%s%s%s", progname,
          "  -h  --help         print this usage and exit\n",
	  "  -i  --interactive  force interactive mode\n",
	  "  -l  --mathlib      use the predefined math routines\n",
	  "  -q  --quiet        don't print initial banner\n",
	  "  -s  --standard     non-standard bc constructs are errors\n",
	  "  -w  --warn         warn about non-standard bc constructs\n",
	  "  -v  --version      print version information and exit\n");
}


static void
parse_args (int argc, char **argv)
{
  int optch;
  int long_index;
  file_node *temp;

  /* Force getopt to initialize.  Depends on GNU getopt. */
  optind = 0;

  /* Parse the command line */
  while (1)
    {
      optch = getopt_long (argc, argv, "chilqswv", long_options, &long_index);

      if (optch == EOF)  /* End of arguments. */
	break;

      switch (optch)
	{
	case 0: /* Long option setting a var. */
	  break;

	case 'c':  /* compile only */
	  compile_only = TRUE;
	  break;

	case 'h':  /* help */
	  usage(argv[0]);
	  bc_exit (0);
	  break;

	case 'i':  /* force interactive */
	  interactive = TRUE;
	  break;

	case 'l':  /* math lib */
	  use_math = TRUE;
	  break;

	case 'q':  /* quiet mode */
	  quiet = TRUE;
	  break;

	case 's':  /* Non standard features give errors. */
	  std_only = TRUE;
	  break;

	case 'v':  /* Print the version. */
	  show_bc_version ();
	  bc_exit (0);
	  break;

	case 'w':  /* Non standard features give warnings. */
	  warn_not_std = TRUE;
	  break;

	default:
	  usage(argv[0]);
	  bc_exit (1);
	}
    }

#ifdef QUIET
  quiet = TRUE;
#endif

  /* Add file names to a list of files to process. */
  while (optind < argc)
    {
      temp = bc_malloc(sizeof(file_node));
      temp->name = argv[optind];
      temp->next = NULL;
      if (last == NULL)
	file_names = temp;
      else
	last->next = temp;
      last = temp;
      optind++;
    }
}

/* The main program for bc. */
int
main (int argc, char **argv)
{
  char *env_value;
  char *env_argv[30];
  int   env_argc;
  
  /* Interactive? */
  if (isatty(0) && isatty(1)) 
    interactive = TRUE;

#ifdef HAVE_SETVBUF
  /* attempt to simplify interaction with applications such as emacs */
  (void) setvbuf(stdout, NULL, _IOLBF, 0);
#endif

  /* Environment arguments. */
  env_value = getenv ("BC_ENV_ARGS");
  if (env_value != NULL)
    {
      env_argc = 1;
      env_argv[0] = strdup("BC_ENV_ARGS");
      while (*env_value != 0)
	{
	  if (*env_value != ' ')
	    {
	      env_argv[env_argc++] = env_value;
	      while (*env_value != ' ' && *env_value != 0)
		env_value++;
	      if (*env_value != 0)
		{
		  *env_value = 0;
		  env_value++;
		}
	    }
	  else
	    env_value++;
	}
      parse_args (env_argc, env_argv);
    }

  /* Command line arguments. */
  parse_args (argc, argv);

  /* Other environment processing. */
  if (getenv ("POSIXLY_CORRECT") != NULL)
    std_only = TRUE;

  env_value = getenv ("BC_LINE_LENGTH");
  if (env_value != NULL)
    {
      line_size = atoi (env_value);
      if (line_size < 3 && line_size != 0)
	line_size = 70;
    }
  else
    line_size = 70;

  /* Initialize the machine.  */
  init_storage();
  init_load();

  /* Set up interrupts to print a message. */
  if (interactive)
    signal (SIGINT, use_quit);

  /* Initialize the front end. */
  init_tree();
  init_gen ();
  is_std_in = FALSE;
  first_file = TRUE;
  if (!open_new_file ())
    bc_exit (1);

#if defined(LIBEDIT)
  if (interactive) {
    /* Enable libedit support. */
    edit = el_init ("bc", stdin, stdout, stderr);
    hist = history_init();
    el_set (edit, EL_EDITOR, "emacs");
    el_set (edit, EL_HIST, history, hist);
    el_set (edit, EL_PROMPT, el_pmtfunc);
    el_source (edit, NULL);
    history (hist, &histev, H_SETSIZE, INT_MAX);
  }
#endif

#if defined(READLINE)
  if (interactive) {
    /* Readline support.  Set both application name and input file. */
    rl_readline_name = "bc";
    rl_instream = stdin;
    using_history ();
  }
#endif

  /* Do the parse. */
  yyparse ();

  /* End the compile only output with a newline. */
  if (compile_only)
    printf ("\n");

  bc_exit (0);
  return 0; // to keep the compiler from complaining
}


/* This is the function that opens all the files. 
   It returns TRUE if the file was opened, otherwise
   it returns FALSE. */

int
open_new_file (void)
{
  FILE *new_file;
  file_node *temp;

  /* Set the line number. */
  line_no = 1;

  /* Check to see if we are done. */
  if (is_std_in) return (FALSE);

  /* Open the other files. */
  if (use_math && first_file)
    {
      /* Load the code from a precompiled version of the math libarary. */
      CONST char **mstr;

      /* These MUST be in the order of first mention of each function.
	 That is why "a" comes before "c" even though "a" is defined after
	 after "c".  "a" is used in "s"! */
      (void) lookup (strdup("e"), FUNCT);
      (void) lookup (strdup("l"), FUNCT);
      (void) lookup (strdup("s"), FUNCT);
      (void) lookup (strdup("a"), FUNCT);
      (void) lookup (strdup("c"), FUNCT);
      (void) lookup (strdup("j"), FUNCT);
      mstr = libmath;
      while (*mstr) {
           load_code (*mstr);
	   mstr++;
      }
    }
  
  /* One of the argv values. */
  if (file_names != NULL)
    {
      new_file = fopen (file_names->name, "r");
      if (new_file != NULL)
	{
	  new_yy_file (new_file);
	  temp = file_names;
	  file_name  = temp->name;
	  file_names = temp->next;
	  free (temp);
	  return TRUE;
	}
      fprintf (stderr, "File %s is unavailable.\n", file_names->name);
      bc_exit (1);
    }
  
  /* If we fall through to here, we should return stdin. */
  new_yy_file (stdin);
  is_std_in = TRUE;
  return TRUE;
}


/* Set yyin to the new file. */

void
new_yy_file (FILE *file)
{
  if (!first_file) fclose (yyin);
  yyin = file;
  first_file = FALSE;
}


/* Message to use quit.  */

void
use_quit (int sig)
{
#ifdef DONTEXIT
  int save = errno;
  write (1, "\n(interrupt) use quit to exit.\n", 31);
  signal (SIGINT, use_quit);
  errno = save;
#else
  write (1, "\n(interrupt) Exiting bc.\n", 26);
  bc_exit(0);
#endif
}
