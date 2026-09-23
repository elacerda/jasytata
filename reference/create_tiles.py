import shutil
import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord, Latitude, Longitude, Angle

from astropy.coordinates import Longitude, Latitude
from copy import deepcopy as copy

def _next_ra_lon(ra, dec, tile_size=1.4, overlap=30):
    _corr_dec = (1/np.cos(dec))
    _delta = _corr_dec*Longitude(tile_size*u.deg - overlap*u.arcsec)
    next_ra = Longitude(ra + _delta)
    return next_ra

def _next_dec_lat(dec, tile_size=1.4, overlap=30):
    _delta = Latitude(tile_size*u.deg - overlap*u.arcsec)
    next_dec = Latitude(dec + _delta)
    return next_dec

def build_big_square_of_tiles_lon_lat(ra_bounds, dec_bounds, tile_size=1.4, overlap=30):
    initial_ra, final_ra = ra_bounds
    initial_dec, final_dec = dec_bounds
    _ra_dir = np.sign(final_ra - initial_ra)
    _dec_dir = np.sign(final_dec - initial_dec)

    if _ra_dir == 0:
        # RA is the initial RA
        # _ra = Angle(initial_ra)
        _ra = Longitude(initial_ra)
    else:
        # always ascending RA
        if _ra_dir < 0:
            _tmp = initial_ra
            initial_ra = final_ra
            final_ra = _tmp
        # fix RA central position using initial RA as the border of the square
        _ra = _next_ra_lon(Longitude(initial_ra), Latitude(initial_dec),
                           tile_size=(0.5*tile_size), overlap=0)

    if _dec_dir == 0:
        # DEC is the initial DEC
        # _dec = Angle(initial_dec)
        _dec = Latitude(initial_dec)
    else:
        # always ascending DEC
        if _dec_dir < 0:
            _tmp = initial_dec
            initial_dec = final_dec
            final_dec = _tmp
        _dec = _next_dec_lat(Latitude(initial_dec), tile_size=(0.5*tile_size), overlap=0)

    first_line_ra = [_ra]

    print('initial_RA:', get_fmt_ra(Longitude(initial_ra)))
    print('final_RA:', get_fmt_ra(Longitude(final_ra)))
    print('initial_dec:', get_fmt_dec(Latitude(initial_dec)))
    print('final_dec:', get_fmt_dec(Latitude(final_dec)))
    
    ra_list, dec_list = [], []
    _ini_ra = copy(_ra)
    while (final_dec - _dec) >= 0:
        ra_list.append(_ra)
        dec_list.append(_dec)
        while (final_ra - _ra) >= 0:
            _ra = _next_ra_lon(_ra, _dec, tile_size=tile_size, overlap=4*overlap)
            if (final_ra - _ra) >= 0:
                ra_list.append(_ra)
                dec_list.append(_dec)
        _ra = copy(_ini_ra)
        _dec = _next_dec_lat(_dec, tile_size=tile_size, overlap=4*overlap)
    return ra_list, dec_list

def output_splus_new(ra_list, dec_list,
                     pidname='MY_SPLUS',
                     ini_pidnumber=0,
                     status=6,
                     N=36):
    _txt = '\n'
    pidnumber = ini_pidnumber
    for ra, dec in zip(ra_list, dec_list):
        pidnumber += 1
        epoc = 2000
        _input = [pidname, pidnumber, get_fmt_ra(ra), get_fmt_dec(dec), epoc, status, N]
        _txt += '{0},{0}_{1:04d},{2},{3},{4},{5},{6}\n'.format(*_input)
    return _txt

def get_fmt_ra(ra):
    return ra.to_string(unit='hour', sep=':', fields=3, decimal=False, precision=0)

def get_fmt_dec(dec):
    return dec.to_string(unit='deg', sep=':', fields=3, decimal=False, precision=0)

if __name__ == '__main__':
    # input options (consider use argparse)
    ra_bounds = [143, 151]*u.deg
    dec_bounds = [-40, -20]*u.deg
    splus_tile_size = 1.4
    splus_overlap = 30

    # script
    ra_list, dec_list = build_big_square_of_tiles_lon_lat(ra_bounds, dec_bounds, tile_size=splus_tile_size, overlap=splus_overlap)
    for ra, dec in zip(ra_list, dec_list):
        print(get_fmt_ra(ra), get_fmt_dec(dec))
    
    #output_filename = 'test.csv'
    #output_splus_new(ra_list, dec_list, status=3)