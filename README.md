nodeca.search
=============

[![Build Status](https://travis-ci.org/nodeca/nodeca.search.svg?branch=master)](http://travis-ci.org/nodeca/nodeca.search)

Nodeca search app.

See main repo for install instructions: https://github.com/nodeca/nodeca


### Stopwords dump memo

__prepare__

1. Rebuild index.
2. Run `optimize index forum_posts` if not optimized yet.

__dump__

```sh
cd <root>/sphinx_data/node<X>
indextool --dumpdict tables/forum_posts.<XX>.spi -c searchd.conf > dump.txt
cat dump.txt | sed -e '0,/keyword,docs,hits,offset/d' | sort -t"," -k 2 -g -r | head -n 1000 | sed -e '/^\x02/d' > dump_top.txt
cat dump_top.txt | sed  's/,.*//' > stopwords.txt
```

Then edit `stopwords.txt`, remove unnecessary words. Use `dump_top.txt` to check
documents number (second column).
