

require('dotenv').config();
const request = require('request-promise');
const Promise = require('bluebird');

const { execAsync } = require('async-child-process');


//const cities = ['paris', 'orlando', 'newyork', 'madrid', 'london'];//, 'madrid', 'london']//;, 'madrid', 'london', 'jakarta'];

const MongoClient = require('mongodb').MongoClient;

const getCities = () => {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            dbo.collection("city").find({}).toArray((err, result) => {
                if (err)
                    return reject(err);

                db.close();
                resolve(result.map((city) => city.name));
            });
        });
    });
}

const getBuilds = () => {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            dbo.collection("build").find({}).toArray((err, result) => {
                if (err)
                    return reject(err);

                db.close();
                resolve(result);
            });
        });
    });
}
const addBuild = (build) => {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            dbo.collection("build").insertOne(build, (err, res) => {
                if (err) {
                    console.log(err);
                    return reject(err);
                }
                //console.log((res.result.upserted ? "Added" : "Skipped") + " build -> " + build);
                db.close();
                resolve(res.ops);
            });
        });
    });
}

const updateBuild = (build) => {
    if (!build._id)
        return addBuild(build);

    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            //console.log('UPDATE', build);
            dbo.collection("build").updateOne({ _id: build._id }, { $set: build }, { upsert: true }, (err, res) => {
                if (err) {
                    console.log(err);
                    return reject(err);
                }
                //console.log((res.result.upserted ? "Added" : "Updated") + " version -> ", build);

                db.close();
                //console.log('res.result', res);
                resolve(res.ops);
            });
        });
    });
}

const dockerBuild = (command, tags, city, build) => {
    console.log(`Building image: ${city}, version: ${build.version}, tags: ${tags}`);

    return Promise.try(() => {
        return execAsync(`docker login -u ${process.env.DOCKER_USER_NAME} -p ${process.env.DOCKER_TOKEN}`, { cwd: './docker' })
    }).then(() => {

        return execAsync(command, { cwd: './docker' }).then(({ stdout, stderr }) => {
            //console.log(stdout, stderr)
            console.log("\tbuild done");

            return Promise.each(tags, ((tag) => {
                command = `docker push ${tag}`;
                console.log(`push tag ${tag}`)
                return execAsync(command, { cwd: './docker' }).then(({ stdout, stderr }) => {
                    console.log(`\t${stdout.split('\n').slice(-2)[0]}`);
                    console.log("\ttag done");
                });
            }));
        });
    }).then(() => {
        return Promise.each(tags, ((tag) => {
            console.log('remove local image ', tag);
            return execAsync(`docker rmi ${tag}`, { cwd: './docker' })
        }));
    });
}

Promise.try(() => {
    return getBuilds().then((builds) => {
        if (process.env.FORCE_REFRESH !== 'true')
            return builds;

        // force reset build done
        console.warn('FORCE REFRESH MODE: replacing all images !')
        return builds.map((build) => {
            build.done = false;
            return build;
        });
    }).then((builds) => {
        return builds.reduce((out, build) => {
            if (out[build.city]) {
                out[build.city].push(build);
            } else {
                out[build.city] = [build];
            }
            return out;
        }, {})
    }).then((versions) => {
        return getCities().then((cities) => {
            return { versions, cities }
        });
    });
}).then(({ versions, cities }) => {

    //console.log("%j", versions)
    //console.log("%j", cities)

    return Promise.mapSeries(cities, (city) => {
        return request(`https://docs.servicenow.com/bundle/${city}-release-notes/toc/release-notes/available-versions.html`).then((html) => {
            const regex = new RegExp(`(https:\/\/docs\.servicenow\.com\/bundle\/${city}-release-notes\/page\/release-notes\/[^\/]+\/[^-]+-patch[^\.]+\.html)`, 'gm');
            let m;
            const patchUrls = [];
            while ((m = regex.exec(html)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }
                patchUrls.push(m[1])
            }
            return patchUrls;
        }).catch((e) => {
            console.error(`city ${city} http request failed! (https://docs.servicenow.com/bundle/${city}-release-notes/toc/release-notes/available-versions.html)`, e.message);
            return [];
        }).then((patchUrls) => {

            return Promise.mapSeries(patchUrls, (url) => {
                console.log('parsing mid version info from ', url);
                return request(url).then((html) => {
                    let regex = />Build tag:\s+(?:glide-)?([^<]+)</i
                    let m = html.match(regex);
                    const out = {
                        tag: undefined,
                        date: undefined
                    };
                    if (m) {
                        out.tag = m[1];
                    }
                    regex = />Build date:\s+([^<]+)</i
                    m = html.match(regex);
                    if (m) {
                        out.date = m[1];
                    }
                    return out;
                })
            })
        }).then((builds) => {
            return builds.map((build) => {

                build.city = city;

                if (build.date) {
                    const dateArray = build.date.split(/[_-]/);
                    if (dateArray.length == 4) {
                        build.version = `${build.tag}_${build.date}`;
                        build.url = `https://install.service-now.com/glide/distribution/builds/package/mid/${dateArray[2]}/${dateArray[0]}/${dateArray[1]}/mid.${build.version}.linux.x86-64.zip`
                        build.id = `${dateArray[2]}${dateArray[0]}${dateArray[1]}${dateArray[3]}`
                        build.tagname = build.tag.split('__')[1]
                    } else {
                        console.warn("patch does not match", build)
                    }
                }
                return build;
            });
        }).then((builds) => {

            const existingBuilds = versions[city];
            if (existingBuilds) {
                builds = builds.filter((b) => {
                    return !existingBuilds.some((ex) => ex.tag == b.tag)
                });
            }

            console.log('New Builds for', city, builds);

            return Promise.map(builds, (build) => {
                console.log('check if zip file exists', build.url)
                return request({ method: 'HEAD', url: build.url }).then(() => true).catch(() => false).then((found) => {
                    build.zipExits = found;
                    if (!found)
                        console.log("zip file not found on server for build", build)
                    return build
                });
            }).then((builds) => {
                return {
                    city,
                    builds: builds
                };
            })

        });
    }).then((newBuilds) => {
        // convert to city map
        return newBuilds.reduce((out, row) => {
            // remove the ones without an id
            out[row.city] = row.builds.filter((p) => p.id);
            return out;
        }, {});
    }).then((newBuilds) => {

        // merge new builds with existing ones
        Object.keys(newBuilds).forEach((nCity) => {
            if (!newBuilds[nCity].length)
                return;

            if (!versions[nCity]) {
                versions[nCity] = newBuilds[nCity]
            } else {
                versions[nCity] = newBuilds[nCity].concat(versions[nCity])
            }
        });
        return versions;

    }).then((versions) => {

        //console.log("%j", versions)

        const versionsLen = Object.keys(versions).length;
        console.log('Total number of cities ', versionsLen)

        return Promise.each(Object.keys(versions).sort(), (city, cityIndex) => {

            console.log(`City: '${city}' index: ${cityIndex}`);

            const builds = versions[city];
            return Promise.each(builds.sort((a, b) => a.id - b.id), (build, buildIndex) => {

                return Promise.try(() => {

                    if (!build.zipExits) {
                        console.log("zip does not exist, skip ", build.url);
                        return;
                    }

                    if (build.done) {
                        console.log("this build is done, skip %j", build.tag)
                        return;
                    }


                    return Promise.try(() => {
                        const tags = [`moers/mid-server:${city}.${build.date}`]; // `moers/mid-server:${city}.${build.tagname}`, 

                        if (buildIndex == 0) {
                            tags.push(`moers/mid-server:${city}`);
                            tags.push(`moers/mid-server:${city}.first`);
                        }

                        if (buildIndex == builds.length - 1) {
                            tags.push(`moers/mid-server:${city}.latest`);
                            if (cityIndex == versionsLen - 1)
                                tags.push('moers/mid-server:latest')
                        }
                        return dockerBuild(`docker build -f ./Dockerfile --build-arg URL=${build.url} ${tags.map((t) => `--tag ${t}`).join(' ')} .`, tags, city, build);

                    }).then(() => {
                        //const tags = [`moers/mid-server:${city}.pin.${build.tagname}`, `moers/mid-server:${city}.pin.${build.date}`];
                        //return dockerBuild(`docker build -f ./Dockerfile --build-arg URL=${build.url} --build-arg VERSION=${build.tag} ${tags.map((t) => `--tag ${t}`).join(' ')} .`, tags, city, build);
                    });


                }).then(() => {
                    build.done = true;
                    return updateBuild(build);
                }).catch((e) => {
                    console.error('somethings wrong', e)
                });

            });



        }).then(() => {
            //console.dir(versions, { depth: null, colors: true });
        });

    }).then(() => {
        //return Promise.delay(9999999)
    });

}).catch((e) => {
    console.error(e);
});

