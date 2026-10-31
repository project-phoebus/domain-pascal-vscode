{   PROC2.INS.PAS, /SYS/INS, JAH, 04/02/86    }

{   Level 2 process manager declarations

    Changes :                             
        04/02/86 joelm proc2_$uid_list defined as n_user_processes+1
        12/06/83 rees Bumped length of proc2_$uid_list_t to 24 }

{   Error codes:    }

CONST
    proc2_$uid_not_found =         16#00190001;
    proc2_$not_level_2   =         16#00190002;
    proc2_$bad_stack_base =        16#00190003;
    proc2_$is_current =            16#00190004;  { info request is for current }

TYPE
    proc2_$state_t = SET OF (proc2_$waiting, proc2_$suspended,
                             proc2_$susp_pending, proc2_$bound);

    proc2_$info_t = RECORD
        stack_uid: uid_$t;        { uid of user stack }
        stack_base: linteger;     { base address of user stack }
        state: proc2_$state_t;    { ready, waiting, etc. }
        usr: pinteger;            { user sr }
        upc: linteger;            { user pc }
        usp: linteger;            { user stack pointer }
        usb: linteger;            { user sb ptr (A6) }
        cpu_total: time_$clock_t; { cumulative cpu used by process }
        priority: 0..127;         { process priority }
    END;

    proc2_$uid_list_t = ARRAY[1..proc1_$n_user_processes+1] OF uid_$t;

PROCEDURE proc2_$list( OUT uid_list: UNIV proc2_$uid_list_t;
                       max_ull: pinteger;   { size of uid_list (in uids) }
                       OUT ull: pinteger    { actual number of level 2 procs }
                     ); EXTERN;             { may be > max_ull }

PROCEDURE proc2_$get_info( IN p2_uid: uid_$t;
                           OUT info: UNIV proc2_$info_t;
                           info_buf_len: pinteger; { size of info buffer (bytes) }
                           OUT sts: status_$t
                         ); EXTERN;

PROCEDURE proc2_$who_am_i( OUT puid:  uid_$t );  EXTERN;

%EJECT;
