program fortran_smoke
  use, intrinsic :: iso_c_binding, only: c_size_t
  implicit none

  interface
    function twice(value) bind(C, name="spike_twice") result(doubled)
      import :: c_size_t
      integer(c_size_t), value :: value
      integer(c_size_t) :: doubled
    end function twice
  end interface

  integer :: unit, status, record_bytes
  logical :: file_exists
  integer(c_size_t) :: value, from_file

  if (storage_size(value) /= 32) stop 10
  value = twice(21_c_size_t)
  if (value /= 42_c_size_t) stop 11
  inquire(iolength=record_bytes) value
  if (record_bytes /= 4) stop 19
  inquire(iolength=record_bytes) [value, value]
  if (record_bytes /= 8) stop 21

  open(newunit=unit, file="/tmp/fortran-spike.txt", status="new", &
       action="write", form="formatted", iostat=status)
  if (status /= 0) stop 12
  write(unit, '(I4)', iostat=status) value
  if (status /= 0) stop 13
  close(unit, iostat=status)
  if (status /= 0) stop 14

  open(newunit=unit, file="/tmp/fortran-spike.txt", status="old", &
       action="read", form="formatted", iostat=status)
  if (status /= 0) stop 15
  read(unit, '(I4)', iostat=status) from_file
  if (status /= 0) stop 16
  if (from_file /= value) stop 17
  close(unit, status="delete", iostat=status)
  if (status /= 0) stop 18
  inquire(file="/tmp/fortran-spike.txt", exist=file_exists, iostat=status)
  if (status /= 0 .or. file_exists) stop 20
  print '(A,I0)', "fortran-spike-ok ", from_file
end program fortran_smoke
